/**
 * Shared object-URL blob download (CSV/JSON exports). The anchor is appended
 * to the document before the click — some browsers (notably Firefox) ignore
 * clicks on detached anchors — and revokeObjectURL is deferred a tick so the
 * navigation the click starts can never race the URL's release.
 */
export const downloadBlob = (fileName: string, blob: Blob): void => {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
};
