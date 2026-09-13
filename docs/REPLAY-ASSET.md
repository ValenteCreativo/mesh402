# Verified replay web derivative

Source Tripo task: `fb48a85c-ac6c-4d25-8ba0-641c2089df24`.
Original GLB: `generated/fb48a85c-ac6c-4d25-8ba0-641c2089df24.glb`.
Original bytes: **41,331,488** (unchanged, Git-ignored).
Original SHA-256: `7d5f8237006bb9dee776091e6a59aa6a04bc60c1e021f1c9ab784445cba3d1c2`.
Web copy: `frontend/public/assets/replay/street-food-cart.optimized.glb`.
Web bytes: **7,961,160**, **80.74% smaller**. Derivative hash is recorded in the
adjacent `manifest.json` together with original provenance and real run metadata.

Inspection using glTF Transform 4.5.0 found 740,794 uploaded vertices and 4,213,650
triangle indices (1,404,550 triangles), with three embedded 2048×2048 JPEG textures
(~769 KB total). Geometry accounts for almost all remaining original bytes.
The derivative retains the triangle/index count and all three JPEG byte hashes.
Meshopt reorders/compresses geometry and quantizes attributes: positions 16 bits,
normals 12 bits, texture coordinates 14 bits. Geometry encoding/precision changed;
there is no mesh simplification or texture recompression/resizing. Do not call the
web copy byte-identical to the generated output.

Reproduce from the original local file (never use the original as output):

```sh
npx --yes @gltf-transform/cli@4.5.0 inspect generated/fb48a85c-ac6c-4d25-8ba0-641c2089df24.glb
npx --yes @gltf-transform/cli@4.5.0 meshopt \
  generated/fb48a85c-ac6c-4d25-8ba0-641c2089df24.glb \
  frontend/public/assets/replay/street-food-cart.optimized.glb \
  --quantize-position 16 --quantize-normal 12 --quantize-texcoord 14
```

The CLI was run as development tooling; it is not an application dependency.
Three.js's existing bundled `MeshoptDecoder` is configured on `GLTFLoader`; no
remote decoder fetch or new runtime package is required. Browser orbit/reset and
replay inspection found no material degradation in the accepted chamber framing.
The inspector and delivery metadata explicitly label the derivative. Public
replay download serves this derivative; the forensic original remains local.
