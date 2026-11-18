# Editor and template license review — 27 October 2026

This is an engineering provenance review, not a legal opinion or a guarantee that every part of Lumen is cleared. It covers the installed runtime dependencies of Workspace, the website-builder client/server, the new font collection, and the stock-media/template changes. It does not certify every historical asset, Python dependency, bundled runtime, user upload, business logo, or AI-generated result in the wider product.

## New fonts

Manrope, Lora, Playfair Display, Libre Baskerville, Space Grotesk, Outfit, IBM Plex Mono, Caveat, DM Sans and Newsreader are distributed unmodified under SIL Open Font License 1.1. They may be used commercially, embedded in websites and bundled with software subject to that license. They remain copyrighted: “free to use” does not mean public domain. Preserve the accompanying copyright and OFL notices, do not sell the font files by themselves, and observe reserved-font-name conditions if modifying them.

The local files, exact upstream URLs and SHA-256 checksums are recorded in `assets/open-fonts/catalog.json`. Fonts do not require a Google Fonts request at runtime. Website ZIP exports include the font files used by the site's CSS, their OFL texts and FONT-LICENSES.txt.

Sources: https://openfontlicense.org/ and https://github.com/google/fonts

## Editor software

`editor-dependency-inventory.json` records 318 installed runtime package entries across the three projects. This is a conservative inventory, not proof that every listed package is included in the browser bundle. License texts and source links are retained in generated third-party notices. MIT, BSD, ISC, Apache and other permissive notices must be preserved where applicable. JSZip uses its MIT option; rgbcolor uses its MIT option; DOMPurify uses its Apache-2.0 option.

BlockNote 0.56.0 is unmodified MPL-2.0 software. Its corresponding source is available from the exact upstream tag and matching npm package distributions. Keep the source-availability notice; modifications to covered files would require a separate MPL review. This does not mean all of Lumen must be open sourced.

Two existing dependencies need further notice clarification before a complete distribution clearance: `use-composed-ref@1.4.0` and `codemirror-formatting@1.0.0` declare MIT in package metadata, but their installed packages and inspected upstream repositories omit a full license text. Do not represent these as fully verified. Other upstream notice supplements identify their exact retrieval URLs; supplements from a default branch are supporting evidence, not a version-specific legal certification.

## Templates and stock media

The template layouts and copy were written for this project. Reference sites were studied for general design ideas; no proprietary Wix, Hostinger or Notion source, templates, branding or screenshots were imported. Similar interaction patterns alone do not establish a legal clearance for a whole product.

Template photographs and the two videos are Pexels stock media. Source IDs and credits are retained in `website_builder/client/src/builder/stockMedia.ts`, and MEDIA-CREDITS.txt accompanies exports. Pexels permits website and commercial uses under its license, with restrictions including standalone redistribution and implied endorsement. Stock content is illustrative, not proof of actual client work, staff or endorsements. The remote media currently needs internet access. Rights relating to recognizable people, trademarks and sensitive uses still depend on the published context.

Workspace cover sources are recorded in `assets/covers/SOURCES.md`. Users must have rights to their own uploaded images and content. AI output needs its own review before publication; model access does not guarantee originality or third-party clearance.

Sources: https://www.pexels.com/license/ and https://help.pexels.com/hc/en-us/articles/360042295214-Can-I-use-the-photos-and-videos-for-a-commercial-project

## Feature research and scope

Wix mobile-editor documentation and Hostinger's styling, mobile and preview documentation informed panel controls, alignment, mobile visibility, image descriptions/focus and link controls. These are independently implemented controls, not integrations with those products.

- https://support.wix.com/en/article/wix-editor-using-the-mobile-editor-tools
- https://support.hostinger.com/en/articles/6475658-website-builder-how-to-edit-the-mobile-version-of-a-website
- https://www.hostinger.com/support/6618106-hostinger-ai-builder-manual-mode-how-to-customize-the-website-s-style/
- https://www.hostinger.com/support/6475345-hostinger-website-builder-how-to-preview-a-website/

This remains a local website editor and export workflow. Hosted publishing, working form delivery, bookings, ecommerce payments, shared accounts and a full CMS are separate features; template appearance does not make those operational.
