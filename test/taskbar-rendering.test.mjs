import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('taskbar stays in the visible strip and fits both rows at 100–200% DPI', { skip: process.platform !== 'win32' }, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-rendering-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourceRoot = fileURLToPath(new URL('../taskbar/', import.meta.url));
  const files = ['BandLayout.cs', 'BandRenderer.cs', 'UsageSnapshot.cs'];
  for (const file of files) fs.copyFileSync(path.join(sourceRoot, file), path.join(root, file));
  fs.writeFileSync(path.join(root, 'RenderTests.csproj'), `<Project Sdk="Microsoft.NET.Sdk">
<PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net48</TargetFramework><LangVersion>latest</LangVersion></PropertyGroup>
<ItemGroup><Reference Include="System.Drawing"/><Reference Include="System.Web.Extensions"/></ItemGroup>
</Project>`);
  fs.writeFileSync(path.join(root, 'Program.cs'), `
using System;
using System.Drawing;
using AgentUsageTaskbar;
class RenderTests {
    static void Check(bool condition, string message) { if (!condition) throw new Exception(message); }
    static int Main(string[] args) {
        try { Run(args); return 0; }
        catch (Exception error) { Console.Error.WriteLine(error.Message); return 1; }
    }
    static void Run(string[] args) {
        var compact = BandLayout.VisibleBounds(new Rectangle(0,1368,2560,72), new Rectangle(0,0,2560,1392));
        Check(compact == new Rectangle(0,24,2560,48), "QHD compact taskbar overlaps work area");
        var full = BandLayout.VisibleBounds(new Rectangle(0,1032,1920,48), new Rectangle(0,0,1920,1032));
        Check(full == new Rectangle(0,0,1920,48), "FHD full taskbar moved");
        var offset = BandLayout.VisibleBounds(new Rectangle(-1920,937,1920,72), new Rectangle(-1920,-95,1920,1056));
        Check(offset.Top == 24 && offset.Height == 48, "Secondary monitor origin ignored");
        var snapshot = new UsageSnapshot();
        var claude = new ProviderInfo { Id="claude", Label="Claude", HasUsage=true, Active=true, LimitStatus="needs-cli" };
        var codex = new ProviderInfo { Id="codex", Label="Codex", HasUsage=true, Active=true, LimitStatus="ok" };
        codex.Limits.Add(new LimitInfo { Window="7d", UsedPercent=75, RecentPercent=10 });
        snapshot.Providers.Add(claude); snapshot.Providers.Add(codex);
        using (var renderer = new BandRenderer()) {
            foreach (var scale in new float[] { 1f, 1.25f, 1.5f, 2f }) {
                foreach (var height in new int[] { 24,32,48,60,72,96 }) {
                    Console.WriteLine("Rendering " + scale + " / " + height);
                    using (var bitmap = renderer.Render(snapshot,false,true,scale,height)) {
                        if (args.Length > 0 && scale==1f && height==24) bitmap.Save(args[0]);
                        Check(bitmap.Height == height, "Bitmap height changed");
                        int upper=0,lower=0;
                        for (int y=0; y<height; y++) for (int x=0; x<bitmap.Width; x++) {
                            if (bitmap.GetPixel(x,y).A <= 1) continue;
                            Check(y > 0 && y < height-1, "Clipped row at " + scale + " / " + height + " pixel " + x + "," + y + " " + bitmap.GetPixel(x,y));
                            if (y < height/2) upper++; else lower++;
                        }
                        Check(upper>20 && lower>20,"Missing provider row");
                        if (scale==1f && height==48) bitmap.Save("qhd-preview.png");
                    }
                }
            }
        }
        Console.WriteLine("24 layouts passed");
    }
}
`);
  execFileSync('dotnet', ['build', path.join(root, 'RenderTests.csproj'), '-c', 'Release', '-nologo', '-v', 'quiet'], { encoding: 'utf8', timeout: 60000 });
  const result = execFileSync(path.join(root, 'bin', 'Release', 'net48', 'RenderTests.exe'), process.env.MONITOR_RENDER_PREVIEW ? [process.env.MONITOR_RENDER_PREVIEW] : [], { cwd: root, encoding: 'utf8' });
  assert.match(result, /24 layouts passed/);
  if (process.env.MONITOR_RENDER_PREVIEW) fs.copyFileSync(path.join(root, 'qhd-preview.png'), process.env.MONITOR_RENDER_PREVIEW);
});
