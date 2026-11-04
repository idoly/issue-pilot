// Shared by the status bar and the Monaco editor. Keep this module free of editor imports so the
// status bar does not pull the editor bundle into the page's initial chunk.
export const sourceIndentation: { tabSize: number; insertSpaces: boolean } = { tabSize: 4, insertSpaces: true };
