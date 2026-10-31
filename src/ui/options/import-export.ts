/**
 * JSON file I/O helper utilities for import/export in the options page.
 *
 * Stateless DOM helpers — no settings or i18n deps.
 */

export function downloadJSON(data: unknown, filename: string): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function openFile(): Promise<string> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (file) {
        try {
          resolve(await file.text());
        } catch (error) {
          reject(error);
        }
      } else {
        reject(new Error('No file selected'));
      }
    };
    input.click();
  });
}
