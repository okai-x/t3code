import { wcagContrast } from "culori";
import { expect, it, vi } from "vite-plus/test";
import { GhosttyTerminalCore } from "./core";
import { renderGhosttySnapshot } from "./renderer";

vi.mock("./vendor/ghostty-vt.wasm?url", async () => ({
  default: (await import("./vendor/ghostty-vt.wasm?inline")).default,
}));
vi.mock("./vendor/ghostty-write-pty.wasm?url&no-inline", async () => ({
  default: (await import("./vendor/ghostty-write-pty.wasm?inline")).default,
}));

it("keeps indexed and RGB text readable against each cell background after theme changes", async () => {
  const theme = {
    foreground: { r: 36, g: 21, b: 35 },
    background: { r: 243, g: 247, b: 244 },
    cursor: { r: 27, g: 125, b: 80 },
  };
  const core = await GhosttyTerminalCore.create(20, 3, 8, 16, theme, () => {});
  const paints: Array<{ text: string; color: string }> = [];
  const decorations: string[] = [];
  const context = {
    canvas: { width: 160, height: 48 },
    fillStyle: "",
    save() {},
    restore() {},
    resetTransform() {},
    beginPath() {},
    moveTo() {},
    lineTo() {},
    closePath() {},
    fill() {
      paints.push({ text: "powerline", color: this.fillStyle });
    },
    rect() {},
    clip() {},
    fillRect(_x: number, _y: number, _width: number, height: number) {
      if (height === 1) decorations.push(this.fillStyle);
    },
    fillText(text: string) {
      paints.push({ text, color: this.fillStyle });
    },
  };
  try {
    core.write(
      "\x1b[38;5;230;4mI\x1b[38;2;255;255;215mR\x1b[48;2;19;32;26mD\x1b[0m" +
        "\r\n\x1b[38;2;255;255;215m█─\ue0b0\x1b[8mH\x1b[0m",
    );
    for (const background of [theme.background, { r: 19, g: 32, b: 26 }, theme.background]) {
      core.setTheme({ ...theme, background });
      paints.length = 0;
      decorations.length = 0;
      const snapshot = core.snapshot();
      renderGhosttySnapshot({
        context: context as unknown as CanvasRenderingContext2D,
        snapshot,
        metrics: { width: 8, height: 16, baseline: 12 },
        fontSize: 12,
        fontFamily: "monospace",
        padding: 0,
        forceFull: true,
        cursorOn: false,
      });
      for (const [index, text] of ["I", "R", "D"].entries()) {
        const color = paints.find((paint) => paint.text.includes(text))!.color;
        const cell = snapshot.rowData[0]!.cells[index]!;
        expect(
          wcagContrast(color, {
            mode: "rgb",
            r: cell.background.r / 255,
            g: cell.background.g / 255,
            b: cell.background.b / 255,
          }),
        ).toBeGreaterThanOrEqual(4.5);
        expect(decorations[index]).toBe(color);
        expect(cell.foreground).toEqual({ r: 255, g: 255, b: 215 });
      }
      expect(paints.find((paint) => paint.text.includes("D"))!.color).toBe("rgb(255, 255, 215)");
      expect(paints.find((paint) => paint.text.includes("█─"))!.color).toBe("rgb(255, 255, 215)");
      expect(paints.find((paint) => paint.text === "powerline")!.color).toBe("rgb(255, 255, 215)");
      expect(paints.some((paint) => paint.text.includes("H"))).toBe(false);
    }
  } finally {
    core.dispose();
  }
});
