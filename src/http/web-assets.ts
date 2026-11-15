// Vite appends an 8-character base64url content hash to emitted bundles. Stable public names such as
// interface-licenses.txt have the same shape, so an all-lowercase segment is treated as stable; that
// misclassification only shortens caching or retains a file, never deletes or pins a changing one.
const hashedAsset = /-(?=[a-z_-]*[A-Z0-9])[A-Za-z0-9_-]{8}\.[a-z0-9]+$/;

/** Whether a Web asset (optionally its .br/.gz sibling) is a content-hashed build output. */
export function isHashedWebAsset(file: string): boolean {
  return hashedAsset.test(file.replace(/\.(?:br|gz)$/, ""));
}
