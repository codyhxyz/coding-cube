`live.js` is hunch.live's browser bundle, `hunch/web/dist/live.js` from
<https://github.com/undrgrnd-labs/hunch> at commit `4d2deca`, unmodified. It is byte-identical to
`esbuild live.ts --bundle --format=esm --target=es2022` (esbuild 0.25.10) at that commit.
hunch is not published to npm, so it is vendored here instead of listed in package.json.
Licensed MIT OR Apache-2.0; the MIT text is in LICENSE.

The weights it loads are EmbeddingGemma 2's image path (Apache-2.0), converted by the same
commit's `examples/browser/convert.py`, and served from R2 rather than from this site.
