/** Self-hosted widget assets may use a backend on a different origin. */
export function resolveWidgetApiUrl(
  script: Pick<HTMLScriptElement, 'src' | 'dataset'> | null
): string {
  return script?.dataset.apiUrl || script?.src.replace(/\/widget(?:\.v[\d.]+)?\.js$/, '/api') || '';
}
