# Alya’s Reader

A calm, local-first ebook and comic reader for your own files. Upload **EPUB, PDF, DOCX, TXT, Markdown, CBZ or CBR**, read in the typography you like, and listen with a natural voice — or turn narration off and read in silence.

Everything stays in your browser. No accounts, no cloud library, no uploads.

```
node server.js        # or: npm start
open http://127.0.0.1:4321
```

Requires Node.js 18 or newer. There are **no npm dependencies** — the browser libraries and fonts are vendored in `public/`.

**Live site:** https://hidzirtawin.github.io/alyas-reader/

The hosted build is static. System voices work everywhere, Out Loud can be reached on localhost (Chromium usually allows this), and ElevenLabs can be called directly from the browser. OpenAI is most reliable through the local server: OpenAI’s browser CORS support is inconsistent for error responses. The local server adds a proxy for cloud providers and Out Loud, keeping things local.

---

## What it does

- **Your library** — drag & drop or pick multiple files. Files are stored in IndexedDB in this browser, along with reading positions, bookmarks and highlights.
- **EPUB** — custom renderer with chapter spine, table of contents, internal links, images, per-chapter progress and word counts. DRM-protected EPUBs are not supported.
- **PDF** — full PDF.js viewer with lazy page rendering, selectable text, zoom, outline navigation and page jump. Bookmarks and narration work per page.
- **DOCX** — imported with Mammoth, including headings, lists, tables, emphasis and embedded images. Word documents are split into chapters at heading boundaries.
- **TXT / Markdown** — plain-text chapter detection, plus a safe Markdown renderer for headings, lists, quotes, code, links and emphasis.
- **Comics (CBZ / CBR)** — page-by-page viewer with natural page ordering, ComicInfo.xml metadata, first-page covers, a page-number grid, jump-to-page, zoom and swipe/keyboard page turns. CBR support uses a bundled WASM build of libarchive (RAR v4 and v5).
- **Natural narration** — Web Speech API voices (free, on-device), or optional OpenAI / ElevenLabs neural voices with your own API key.
- **Silent reading** — switch narration off entirely in Settings or the voice picker. The reader becomes text-only and the Listen controls disappear.
- **Listen along** — sentence-by-sentence playback with highlighting, auto-scroll, previous/next sentence, speed control, and automatic chapter (or PDF page) advance. Comic pages are images, so narration is unavailable there.
- **Make it yours** — six typefaces, four themes (Paper, Sepia, Night, Black), text size, line height, measure, paragraph spacing, justification and hyphenation.
- **Marks & notes** — bookmarks and four-colour highlights with notes. Everything is grouped by book and reopens at the exact spot.
- **Autosave** — position, settings, bookmarks and highlights are saved as you read. Comic progress and bookmarks are page-based. Export a JSON backup of notes and progress at any time.
- **Keyboard-first** — see shortcuts below.

## Narration

Open **Settings → Voice & narration → Configure**, or the voice button in the reader.

### System voices (free)

Alya’s Reader lists the English voices installed on your device. On macOS, more natural voices are available in:

**System Settings → Accessibility → Spoken Content → System Voice → Manage Voices**

Download any “Enhanced” or “Premium” English voice; it will appear in Alya’s Reader after a reload.

Speed (0.5×–2×), pitch and highlight-while-reading are adjustable.

### Out Loud voices (free, local, recommended)

Alya’s Reader can use [Out Loud](https://github.com/light-cloud-com/out-loud), a free, source-available, offline desktop TTS app built on Kokoro-82M. It exposes a local API on `127.0.0.1:51730`.

1. Install and open Out Loud from its [releases page](https://github.com/light-cloud-com/out-loud/releases/latest).
2. In Alya’s Reader, open **Voice settings → Out Loud**.
3. Choose a voice (or enter a blend such as `af_heart*0.6 + am_michael*0.4`) and save.

Voices are generated on your computer and never leave it. The hosted GitHub Pages build can usually reach Out Loud through the browser; if your browser blocks localhost access, use the local version of Alya’s Reader. Out Loud is a separate project licensed **PolyForm Noncommercial 1.0.0**; no Out Loud code is bundled here. For commercial use, check its license.

### Neural voices (optional)

Choose **OpenAI** or **ElevenLabs** in the voice picker and paste an API key.

- OpenAI: `gpt-4o-mini-tts`, `tts-1-hd` or `tts-1`; voices including Alloy, Nova, Onyx and Shimmer; optional narration-style instructions.
- ElevenLabs: `eleven_multilingual_v2`, `eleven_turbo_v2_5` or `eleven_flash_v2_5`; six voice presets plus a custom voice ID.

The key is stored **only in this browser** (localStorage). When you run the local server it is sent through the app’s `/api/tts` proxy; on the hosted GitHub Pages version the browser calls the provider directly over HTTPS. It is never written to the server, logs or the app’s own storage. Cloud audio is cached in memory for the current session and never saved to disk.

Audio is generated in small sentence chunks, prefetched one ahead, and played through a normal `<audio>` element. ElevenLabs speed is applied client-side because its API does not accept a rate parameter for all models.

### No voice at all

Pick **Silent** in the voice picker, or turn off **Read aloud** in Settings. No speech engine is invoked; the Listen button and narration dock are hidden. Bookmarks, highlights, notes and progress are unaffected.

Comic books are always silent because their pages are images; the Listen control is hidden automatically.

## Keyboard shortcuts

| Action | Keys |
| --- | --- |
| Add a book (library) | `⌘O` / `Ctrl+O` |
| Search library | `/` |
| Turn chapter / PDF or comic page | `←` `→` |
| Scroll / turn comic page | `↑` `↓` `Space` `PageUp` `PageDown` |
| Listen / pause | `T` |
| Bookmark this spot | `B` |
| Contents | `C` |
| Appearance panel | `A` |
| Close panel / reader | `Esc` |
| Shortcut help | `?` |

## Privacy

- Book files are read locally and stored in **IndexedDB** as blobs. They are never uploaded to a server.
- Reading positions, bookmarks, highlights and notes are also local.
- Settings and voice keys use localStorage.
- The only network request the app can make on your behalf is the optional neural-TTS call to OpenAI or ElevenLabs, via the local server.
- “Export notes & data” downloads a JSON file with metadata, positions, bookmarks, highlights and settings (API keys are omitted). Book files are not included.
- “Delete all books & marks” erases the local database; settings remain.

The server binds to `127.0.0.1` by default. To use another port:

```bash
PORT=8080 npm start
```

To read on another device on your local network (same Wi-Fi), bind to all interfaces:

```bash
HOST=0.0.0.0 PORT=8080 npm start
# then open http://<your-computer-ip>:8080 on the phone
```

Alya’s Reader has no login, so only do this on a trusted network.

## Project layout

```
server.js                 zero-dependency static server + TTS proxy
public/
  index.html              app shell and inline SVG icon set
  css/app.css             themes, library, reader, PDF, responsive UI
  js/
    main.js               app bootstrap, navigation, uploads, search
    library.js            library, import pipeline, drag & drop
    bookmarks.js          bookmarks + highlights view
    settings.js           appearance, narration, voice picker, data
    reader.js             reading, progress, marks, TTS integration
    renderers.js          EPUB / DOCX / TXT / MD parsing
    pdfview.js            PDF.js viewer, text layer, page narration
    comicview.js          paged CBZ/CBR viewer, zoom, page grid
    tts.js                speech engine + cloud voice client
    db.js                 IndexedDB library and marks
    prefs.js              persisted preferences
    ui.js                 modals, toasts, menus, covers
    details.js            shared book details dialog
    util.js               small helpers
  fonts/                  Literata, Atkinson Hyperlegible, Inter, Fraunces
  vendor/                 JSZip, Mammoth, PDF.js + standard fonts, libarchive WASM (CBR)
```

## Notes and limits

- **DRM-free files only.** Encrypted EPUBs cannot be opened. Password-protected PDFs prompt for the password when opened.
- **Scanned PDFs** need an OCR text layer for narration and text selection; image-only pages have nothing to read aloud.
- **Comics are image-based**, so narration is disabled for CBZ/CBR. Password-protected comic archives are not supported yet. CBR relies on libarchive’s RAR support; if a specific RAR variant fails, convert it to CBZ (a ZIP of page images).
- **Legacy `.doc` / `.rtf` / MOBI / AZW** are not supported. Save as DOCX, EPUB or PDF first.
- **Very large books** (hundreds of MB) may exceed the browser’s storage quota. The library reports storage usage in Settings.
- Alya’s Reader is a local web app; keep the server running while reading. Nothing is bundled with the project.

## Credits

- [PDF.js](https://mozilla.github.io/pdf.js/) (Apache-2.0) — PDF rendering
- [Mammoth](https://github.com/mwilliamson/mammoth.js) (BSD-2-Clause) — DOCX conversion
- [JSZip](https://stuk.github.io/jszip/) (MIT) — EPUB and CBZ container parsing
- [libarchive.js](https://github.com/nika-begiashvili/libarchivejs) (MIT; WASM port of libarchive) — CBR/RAR extraction
- [Out Loud](https://github.com/light-cloud-com/out-loud) by Light Cloud Labs (PolyForm Noncommercial 1.0.0) — optional local Kokoro-82M voice engine, used via its HTTP API
- Typefaces: Literata, Atkinson Hyperlegible, Inter and Fraunces (SIL Open Font License), served locally from Fontsource builds.

Built for quiet afternoons and long train rides.
