interface CodeMirrorEditor {
  getValue(): string;
  setValue(value: string): void;
  setOption(name: string, value: unknown): void;
  setSize(width: string | number | null, height: string | number | null): void;
  on(event: "change", handler: () => void): void;
  refresh(): void;
  focus(): void;
}

interface CodeMirrorConstructor {
  fromTextArea(element: HTMLTextAreaElement, options: Record<string, unknown>): CodeMirrorEditor;
}

interface Window {
  CodeMirror?: CodeMirrorConstructor;
}