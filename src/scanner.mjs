import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { parseJsonLine } from './parsers/common.mjs';

// Tails one provider's JSONL directory into the shared database.
export class SessionScanner {
  constructor({ parser, root, lookbackDays, database, onChange, logger = console }) {
    this.parser = parser;
    this.provider = parser.provider;
    this.sessionsRoot = root;
    this.lookbackDays = lookbackDays;
    this.database = database;
    this.onChange = onChange;
    this.logger = logger;
    this.pendingPaths = new Set();
    this.processing = false;
    this.watcher = null;
    this.fullScanTimer = null;
    this.pendingTimer = null;
    this.status = {
      provider: parser.provider,
      root,
      state: 'starting',
      scannedFiles: 0,
      parsedRecords: 0,
      parseErrors: 0,
      lastScanAt: null,
      lastError: null,
    };
  }

  async start() {
    await fsp.mkdir(this.sessionsRoot, { recursive: true });
    await this.fullScan();
    this.#startWatcher();
    this.fullScanTimer = setInterval(() => {
      this.fullScan().catch((error) => this.#recordError(error));
    }, 30_000);
    this.fullScanTimer.unref();
    this.status.state = 'watching';
  }

  async stop() {
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    if (this.fullScanTimer) clearInterval(this.fullScanTimer);
    this.watcher?.close();
    this.watcher = null;
    this.status.state = 'stopped';
  }

  async fullScan() {
    const files = await collectJsonlFiles(this.sessionsRoot, this.lookbackDays);
    for (const filePath of files) this.pendingPaths.add(filePath);
    await this.#drain();
    this.status.lastScanAt = new Date().toISOString();
  }

  snapshot() {
    return { ...this.status, queuedFiles: this.pendingPaths.size };
  }

  #startWatcher() {
    try {
      this.watcher = fs.watch(this.sessionsRoot, { recursive: true }, (_eventType, fileName) => {
        if (!fileName || !String(fileName).toLowerCase().endsWith('.jsonl')) return;
        this.pendingPaths.add(path.resolve(this.sessionsRoot, String(fileName)));
        this.#scheduleDrain();
      });
      this.watcher.on('error', (error) => this.#recordError(error));
    } catch (error) {
      this.#recordError(error);
      this.logger.warn('Recursive file watching is unavailable; the 30-second fallback scan remains active.');
    }
  }

  #scheduleDrain() {
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    this.pendingTimer = setTimeout(() => {
      this.#drain().catch((error) => this.#recordError(error));
    }, 150);
  }

  async #drain() {
    if (this.processing) return;
    this.processing = true;
    let changed = false;
    try {
      while (this.pendingPaths.size > 0) {
        const [filePath] = this.pendingPaths;
        this.pendingPaths.delete(filePath);
        changed = (await this.#processFile(filePath)) || changed;
      }
    } finally {
      this.processing = false;
    }
    if (changed) {
      this.database.reconcileAttributions();
      this.onChange?.(this.provider);
    }
  }

  async #processFile(filePath) {
    let stats;
    try {
      stats = await fsp.stat(filePath);
    } catch (error) {
      if (error.code !== 'ENOENT') this.#recordError(error);
      return false;
    }
    if (!stats.isFile()) return false;

    const saved = this.database.getFileState(filePath);
    let offset = Number(saved?.offset || 0);
    if (stats.size < offset) offset = 0;
    if (stats.size === offset && Number(saved?.mtime_ms || 0) === stats.mtimeMs) return false;

    const handle = await fsp.open(filePath, 'r');
    let buffer;
    try {
      const length = stats.size - offset;
      buffer = Buffer.allocUnsafe(length);
      if (length > 0) await handle.read(buffer, 0, length, offset);
    } finally {
      await handle.close();
    }

    const lastNewline = buffer.lastIndexOf(0x0a);
    if (lastNewline < 0) return false;
    const complete = buffer.subarray(0, lastNewline + 1);
    const state = this.parser.createState({
      sessionId: saved?.session_id,
      currentTurnId: saved?.current_turn_id,
      currentModel: saved?.current_model,
      currentEffort: saved?.current_effort,
    });
    let cursor = 0;
    let records = 0;
    let parseErrors = 0;

    this.database.transaction(() => {
      while (cursor < complete.length) {
        const newline = complete.indexOf(0x0a, cursor);
        if (newline < 0) break;
        const lineOffset = offset + cursor;
        const line = complete.subarray(cursor, newline).toString('utf8').trim();
        cursor = newline + 1;
        if (!line) continue;
        const record = parseJsonLine(line);
        if (!record) {
          parseErrors += 1;
          continue;
        }
        records += 1;

        for (const action of this.parser.parse(record, state, filePath)) {
          if (action.type === 'session') this.database.applySession(action.metadata);
          else this.database.applyAction(action, action.eventId || `${filePath}:${lineOffset}`);
        }
      }

      this.database.saveFileState(filePath, {
        offset: offset + cursor,
        size: stats.size,
        mtimeMs: stats.mtimeMs,
        sessionId: state.sessionId,
        currentTurnId: state.currentTurnId,
        currentModel: state.currentModel,
        currentEffort: state.currentEffort,
      });
    });

    this.status.scannedFiles += 1;
    this.status.parsedRecords += records;
    this.status.parseErrors += parseErrors;
    this.status.lastError = null;
    return records > 0;
  }

  #recordError(error) {
    this.status.state = 'degraded';
    this.status.lastError = error instanceof Error ? error.message : String(error);
    this.logger.error(error);
  }
}

async function collectJsonlFiles(root, lookbackDays) {
  const threshold = Date.now() - lookbackDays * 86_400_000;
  const files = [];

  async function walk(directory) {
    let entries;
    try {
      entries = await fsp.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return;
    }
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(entryPath);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.jsonl')) {
        const stats = await fsp.stat(entryPath);
        if (stats.mtimeMs >= threshold) files.push({ path: entryPath, mtimeMs: stats.mtimeMs });
      }
    }
  }

  await walk(root);
  return files.sort((left, right) => left.mtimeMs - right.mtimeMs || left.path.localeCompare(right.path)).map((file) => file.path);
}
