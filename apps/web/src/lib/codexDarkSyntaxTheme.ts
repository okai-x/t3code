import { getResolvedOrResolveTheme, registerCustomTheme, type DiffsTheme } from "@pierre/diffs";

/** pierre-dark with its syntax palette swapped for Codex's softer one. */
export const CODEX_DARK_THEME_NAME = "t3-dark";

// pierre-dark syntax color -> Codex color, in order: keywords, operators, numbers, functions,
// types, classes, strings, variables, builtins, constants, parameters, punctuation.
const CODEX_SYNTAX_COLORS: Readonly<Record<string, string>> = {
  "#ff678d": "#f07c79",
  "#08c0ef": "#7ac9f2",
  "#68cdf2": "#7ac9f2",
  "#9d6afb": "#b46efc",
  "#d568ea": "#b46efc",
  "#60d199": "#b46efc",
  "#5ecc71": "#87dd7e",
  "#ffa359": "#f49e54",
  "#ffab16": "#f49e54",
  "#ffd452": "#f49e54",
  "#a3a3a3": "#999999",
  "#636363": "#8f8f8f",
};

function codexSyntaxColor(color: string): string {
  return CODEX_SYNTAX_COLORS[color.toLowerCase()] ?? color;
}

type ZedTheme = NonNullable<DiffsTheme["zed"]>;

function withCodexSyntax(theme: ZedTheme): ZedTheme {
  const syntax = Object.fromEntries(
    Object.entries(theme.style.syntax ?? {}).map(([scope, style]) => [
      scope,
      typeof style === "string"
        ? codexSyntaxColor(style)
        : style.color
          ? { ...style, color: codexSyntaxColor(style.color) }
          : style,
    ]),
  );
  return { ...theme, name: CODEX_DARK_THEME_NAME, style: { ...theme.style, syntax } };
}

// Themes resolve on the main thread and reach the diff workers already resolved.
registerCustomTheme(
  CODEX_DARK_THEME_NAME,
  async () => {
    const base = await getResolvedOrResolveTheme("pierre-dark", "highlights");
    if (!base.zed) throw new Error("pierre-dark has no Highlights palette");
    return withCodexSyntax(base.zed);
  },
  "zed",
);
