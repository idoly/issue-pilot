import darkTheme from "../../../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/dark.json";

type ThemeValue = string | number;

function cssName(value: string): string {
  return value.replace(/[A-Z]/g, (character) => `-${character.toLowerCase()}`);
}

function resolveThemeValue(value: ThemeValue): ThemeValue {
  return typeof value === "string" && value in darkTheme.vars
    ? darkTheme.vars[value as keyof typeof darkTheme.vars]
    : value;
}

function cssColor(value: ThemeValue): string {
  if (typeof value === "string") return value || "#d4d4d4";
  if (value < 16) {
    const basic = ["#000000", "#800000", "#008000", "#808000", "#000080", "#800080", "#008080", "#c0c0c0", "#808080", "#ff0000", "#00ff00", "#ffff00", "#0000ff", "#ff00ff", "#00ffff", "#ffffff"];
    return basic[value]!;
  }
  if (value < 232) {
    const channel = (component: number) => component === 0 ? 0 : 55 + component * 40;
    const offset = value - 16;
    return `rgb(${channel(Math.floor(offset / 36))} ${channel(Math.floor(offset / 6) % 6)} ${channel(offset % 6)})`;
  }
  const gray = 8 + (value - 232) * 10;
  return `rgb(${gray} ${gray} ${gray})`;
}

export const piDarkThemeStyle = [
  ...Object.entries(darkTheme.colors).map(([name, value]) => `--pi-${cssName(name)}:${cssColor(resolveThemeValue(value))}`),
  ...Object.entries(darkTheme.export).map(([name, value]) => `--pi-export-${cssName(name)}:${cssColor(resolveThemeValue(value))}`),
].join(";");
