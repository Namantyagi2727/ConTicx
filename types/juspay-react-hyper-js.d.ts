// @juspay-tech/react-hyper-js ships without TypeScript declarations
// (it's a ReScript-compiled bundle with no .d.ts file). This shim just
// tells TypeScript the module exists so the import doesn't fail the
// build; everything from it is implicitly `any`.
declare module "@juspay-tech/react-hyper-js";
