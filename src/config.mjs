import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));

export const APP_NAME = 'agent-usage-monitor';
export const APP_VERSION = '0.2.0';
export const DEFAULT_PORT = 47831;
export const DEFAULT_LOOKBACK_DAYS = 30;
export const ROOT_DIRECTORY = path.resolve(sourceDirectory, '..');
export const PUBLIC_DIRECTORY = path.join(ROOT_DIRECTORY, 'public');
export const RATE_CARD_PATH = path.join(ROOT_DIRECTORY, 'config', 'rate-card.json');

export function resolveConfiguration(argumentsList = process.argv.slice(2), environment = process.env) {
  const argumentValue = (name) => {
    const index = argumentsList.indexOf(name);
    return index >= 0 ? argumentsList[index + 1] : undefined;
  };

  const codexHome = path.resolve(
    argumentValue('--codex-home') || environment.CODEX_HOME || path.join(os.homedir(), '.codex'),
  );
  const claudeHome = path.resolve(
    argumentValue('--claude-home') || environment.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'),
  );
  const stateRoot = path.resolve(
    argumentValue('--state-root') ||
      environment.AGENT_USAGE_MONITOR_STATE_ROOT ||
      path.join(os.homedir(), '.agent-usage-monitor'),
  );
  const parsedPort = Number(argumentValue('--port') || environment.AGENT_USAGE_MONITOR_PORT || DEFAULT_PORT);
  const parsedLookback = Number(
    argumentValue('--lookback-days') ||
      environment.AGENT_USAGE_MONITOR_LOOKBACK_DAYS ||
      DEFAULT_LOOKBACK_DAYS,
  );

  if (!Number.isInteger(parsedPort) || parsedPort < 1024 || parsedPort > 49151) {
    throw new Error(`Port must be an integer from 1024 through 49151. Received: ${parsedPort}`);
  }
  if (!Number.isFinite(parsedLookback) || parsedLookback < 1 || parsedLookback > 3650) {
    throw new Error(`Lookback days must be from 1 through 3650. Received: ${parsedLookback}`);
  }

  return {
    host: '127.0.0.1',
    port: parsedPort,
    sources: [
      { provider: 'codex', root: path.join(codexHome, 'sessions') },
      { provider: 'claude', root: path.join(claudeHome, 'projects') },
    ],
    claudeCredentialsPath: path.join(claudeHome, '.credentials.json'),
    stateRoot,
    // Price overrides from the former Codex-only monitor are copied once on first start.
    legacyStateRoot: path.join(os.homedir(), '.codex-usage-monitor'),
    databasePath: path.join(stateRoot, 'usage.sqlite3'),
    pidPath: path.join(stateRoot, 'service.pid'),
    lookbackDays: parsedLookback,
  };
}
