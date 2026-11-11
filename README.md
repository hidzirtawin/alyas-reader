# Alya’s Reader

A calm, local-first ebook and comic reader for your own files. Upload **EPUB, PDF, DOCX, ODT, RTF, HTML, FB2, TXT, Markdown, CBZ or CBR**, read in the typography you like, and listen with a natural voice — or turn narration off and read in silence.

Your books stay in your browser. No accounts, no cloud library, no uploads. Voice models download once from the open Piper catalog.

```
node server.js        # or: npm start
open http://127.0.0.1:4321
```

Requires Node.js 18 or newer. There are **no npm dependencies** — the browser libraries and fonts are vendored in `public/`.

**Live site:** https://hidzirtawin.github.io/alyas-reader/

The hosted build is static. **Piper** neural voices run entirely in the browser and work on both the hosted and local versions. A voice model downloads once from Hugging Face, is cached by the browser, and then works offline. No accounts or API keys.

---

## What it does

- **Your library** — drag & drop or pick multiple files. Files are stored in IndexedDB in this browser, along with reading positions, bookmarks and highlights.
- **EPUB** — custom renderer with chapter spine, table of contents, internal links, images, per-chapter progress and word counts. DRM-protected EPUBs are not supported.
- **PDF** — full PDF.js viewer with lazy page rendering, selectable text, zoom, outline navigation and page jump. Bookmarks and narration work per page.
- **DOCX** — imported with Mammoth, including headings, lists, tables, emphasis and embedded images. Word documents are split into chapters at heading boundaries.
- **HTML / ODT / RTF / FB2** — HTML is sanitised and flattened into readable chapters, ODT reads the OpenDocument text, RTF is converted to clean paragraphs, and FB2 fiction books keep their sections and titles.
- **TXT / Markdown** — plain-text chapter detection, plus a safe Markdown renderer for headings, lists, quotes, code, links and emphasis.
- **Comics (CBZ / CBR)** — page-by-page viewer with natural page ordering, ComicInfo.xml metadata, first-page covers, a page-number grid, jump-to-page, zoom and swipe/keyboard page turns. CBR support uses a bundled WASM build of libarchive (RAR v4 and v5).
- **Natural narration** — the full **Piper** catalog: 179 free neural voices across 30+ languages, including American, British, Scottish, Northern/Southern English and Australian accents. Runs locally in the browser — the default is an audiobook-style voice that downloads once in the background.
- **Silent reading** — switch narration off entirely in Settings or the voice picker. The reader becomes text-only and the Listen controls disappear.
- **Listen along** — sentence-by-sentence playback with current-word highlighting, auto-scroll, previous/next sentence, fine-grained speed control, and a whole-book seek bar with estimated elapsed/total time. The next sentences are generated and decoded ahead, so playback stays gapless across sentences and chapters; the voice engine warms in the background so the first tap starts quickly.
- **Make an audiobook** — from the book menu, render a whole book or one chapter/page into a **single MP3 file**, or into **MP3 chapter files** bundled in a zip with an `m3u` playlist and metadata. Choose any Piper voice and speaker for the export, independent of your reading voice, and preview the sample before starting. The library card menu, book details and reader menu also offer a one-click **Download audio** action that renders the whole book to a single MP3. Encoded chapters are saved on-device as they are made, so a reload resumes the export, and the finished file is downloaded from disk instead of being held in memory. No Audible account, DRM or cloud service is involved. Comic pages are images, so narration is unavailable there.
- **Languages** — books are detected automatically (script and stop-word analysis, plus EPUB/ODT/FB2 metadata). Non-English books use a matching Piper voice when one is available, and hyphenation follows the book’s language.
- **Dictionary** — select a word and tap **Define**, or double-click it. A public-domain Webster’s 1913 dictionary is stored offline; other languages also get a Wiktionary link.
- **Move around** — previous/next chapter buttons sit in the reader footer, the chapter label opens contents, and a chapter dropdown jumps straight to any section. Press `G` for PDF/comic page jumps or a chapter-and-position jump.
- **Continuous chapter scroll** — an optional layout in Settings → Reading comfort that flows chapters into one long page, appending the next chapter as you read. Narration crosses the joins without stopping.
- **Search inside a book** — `⌘F` / `Ctrl+F` or More → Search in book. EPUB/text books search chapters; PDFs search every page's text layer. Results show chapter/page and context; choosing one jumps there and highlights the match.
- **Offline & installable** — a service worker caches the app shell after the first visit, so the reader opens without a network connection and can be installed to the home screen.
- **Voice storage manager** — see how much space downloaded voice models use, remove individual voices, or clear them all from Settings → Data.
- **Make it yours** — 13 typefaces in a dropdown (Literata, Merriweather, Lora, EB Garamond, Libre Baskerville, Source Serif 4, Georgia, Palatino, Atkinson, Lexend, Inter, OpenDyslexic and System), four themes (Paper, Sepia, Night, Black), text size, line height, measure, paragraph and letter/word spacing, justification and hyphenation.
- **Dyslexia-friendly mode** — one tap sets OpenDyslexic, larger text, roomy lines, wider letter/word spacing and left-aligned text.
- **Sleep timer** — choose 5 to 90 minutes in Settings or the reader menu; narration stops and the screen dims when it ends.
- **Marks & notes** — bookmarks and four-colour highlights with notes. Everything is grouped by book and reopens at the exact spot.
- **Refresh-safe** — uploaded books, settings, positions, bookmarks and highlights live in IndexedDB. Files that were mid-import when the page refreshed are kept and the import resumes automatically on the next load.
- **Library backup** — download one zip containing every book file, cover, reading position, bookmark and note; restore it on this or another device. A lightweight notes-only export is also available.
- **Collections** — group books from the book menu, then filter the library with collection chips.
- **Interruption recovery** — if the browser reloads or interrupts playback, Alya’s Reader reopens the same book and chapter and resumes narration automatically where the browser allows it. Narration uses Web Audio, so iOS keeps playing through the lock screen and the ring/silent switch, survives phone calls, and starts again as soon as you touch the page. A stalled or failed voice generation is retried automatically instead of ending the session.
- **Keyboard-first** — see shortcuts below.

## Narration

Open **Settings → Voice & narration → Configure**, or the voice button in the reader.

### Piper — free, offline, default

Alya’s Reader runs [Piper](https://github.com/rhasspy/piper) (MIT) entirely in your browser. The full catalog is included:

- **179 voices** across 30+ languages
- American, British, Scottish, Northern English, Southern English and **Australian** accents
- Multi-speaker models with a searchable, expandable speaker browser
- Adjustable 0.5×–2× speed and a **pause-between-sentences** control for natural reading rhythm
- A live **download progress bar** (percent and megabytes) in the voice picker and the reading dock
- The full **LibriVox (LibriTTS)** catalog exposes all **2,306 speakers** in a searchable list — browse 60 at a time or search by name/number
- The voice/speaker you pick appears in a visible chip in the reader header; tap it to change voices
- **Regional accents from open research corpora** — VCTK British, Scottish, Northern Irish, Irish, Welsh, South African, Indian and New Zealand English; four Australian voices from the AU LibriVox model (Matilda, Marlo, Banjo and Flynn); L2-ARCTIC Mandarin-, Hindi-, Vietnamese- and Korean-accented English

The default voice is **LibriVox (LibriTTS)** with 2,306 speakers. It starts downloading in the background the first time you open the app, with a progress bar, and is cached for offline use. The first time you choose any other voice, its model is downloaded from Hugging Face and stored in the browser. Models range from about 20 MB to 115 MB; after that the voice works offline. No account or API key is involved, and your book text never leaves your device.

The Australian voice is a community LibriVox model by DataCraftsmanAustralia, licensed **CC-BY-4.0**. Its ten speakers are available in the speaker picker.

**Not included:** a Texas-drawl preset, celebrity clones, or the proprietary narrators used by Audible, Libby and OverDrive. Those narrators are human or licensed voices, and unauthorized impersonations are intentionally excluded. The audiobook and accent voices are original open Piper voices chosen for a similar feel.

### Importing a voice

Any Piper-compatible `.onnx` model with its `.onnx.json` config (or a zip containing both) can be imported from **Settings → Voice & narration → Configure → Piper → Import a Piper voice**. This is the way to use community models trained on [Mozilla Common Voice](https://github.com/common-voice/common-voice), LibriTTS or other open datasets. The files stay in your browser and can be removed from the same panel.

### No voice at all

Pick **Silent** in the voice picker, or turn off **Read aloud** in Settings. No speech engine is invoked; the Listen button and narration dock are hidden. Bookmarks, highlights, notes and progress are unaffected.

Comic books are always silent because their pages are images; the Listen control is hidden automatically.

## Offline & installing

After the first visit the app shell, fonts and scripts are cached by a service worker, so Alya’s Reader opens without a network connection. Books, bookmarks, the dictionary and downloaded voices were already stored locally. If you add it to your home screen or install it from the browser menu, it opens like an app.

The browser still needs the network once to download a new voice or the first dictionary lookup.

## Free book sources

**Free books** in the library toolbar opens a curated shelf of legal places to find ebooks:

- public-domain libraries such as Project Gutenberg, Standard Ebooks, Internet Archive, Open Library and Planet eBook
- free and discounted books from BookBoon, Smashwords, Obooko and Open Culture
- audiobooks and catalogues such as LibriVox, Audible, Goodreads, BookBub and Google Books
- library borrowing through Libby and OverDrive with a library card

Every link opens in a new tab. Use **Add a downloaded book** in that window to bring the file into your library.
Piracy mirrors (LibGen, Z-Library, Anna's Archive, PDF Drive and similar) are deliberately not linked.

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
- Settings use localStorage.
- When you choose a Piper voice, its model and voice tensor are downloaded once from Hugging Face and cached in your browser. After that, narration is fully offline. Your book text is never sent anywhere.
- “Export notes & data” downloads a JSON file with metadata, positions, bookmarks, highlights and settings. Book files are not included.
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
server.js                 zero-dependency static server
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
    tts.js                speech engine + Piper catalog/voice engine
    db.js                 IndexedDB library and marks
    prefs.js              persisted preferences
    ui.js                 modals, toasts, menus, covers
    details.js            shared book details dialog
    util.js               small helpers
  fonts/                  Literata, Atkinson Hyperlegible, Inter, Fraunces
  vendor/                 JSZip, Mammoth, PDF.js + standard fonts, libarchive WASM (CBR), Piper browser runtime
```

## Notes and limits

- **DRM-free files only.** Encrypted EPUBs cannot be opened. Password-protected PDFs prompt for the password when opened.
- **Scanned PDFs** need an OCR text layer for narration and text selection; image-only pages have nothing to read aloud.
- **Comics are image-based**, so narration is disabled for CBZ/CBR. Password-protected comic archives are not supported yet. CBR relies on libarchive’s RAR support; if a specific RAR variant fails, convert it to CBZ (a ZIP of page images).
- **Legacy `.doc` / `.rtf` / MOBI / AZW** are not supported. Save as DOCX, EPUB or PDF first.
- **Piper’s first use** downloads a voice model (about 20–115 MB) and can take a minute; a progress bar shows the download, and later sentences are prefetched while the current one plays. The model is cached in the browser.
- **Very large books** (hundreds of MB) may exceed the browser’s storage quota. The library reports storage usage in Settings.
- Alya’s Reader is a local web app; keep the server running while reading. Nothing is bundled with the project.

## Credits

- [PDF.js](https://mozilla.github.io/pdf.js/) (Apache-2.0) — PDF rendering
- [Mammoth](https://github.com/mwilliamson/mammoth.js) (BSD-2-Clause) — DOCX conversion
- [JSZip](https://stuk.github.io/jszip/) (MIT) — EPUB and CBZ container parsing
- [libarchive.js](https://github.com/nika-begiashvili/libarchivejs) (MIT; WASM port of libarchive) — CBR/RAR extraction
- [Piper](https://github.com/rhasspy/piper) (MIT) — neural text-to-speech engine
- [piper-tts-web](https://github.com/Poket-Jony/piper-tts-web) (MIT) — browser/WASM wrapper and worker runtime
- [Piper voice models](https://huggingface.co/rhasspy/piper-voices) (MIT) — official voice catalog
- [lamejs](https://github.com/zhuker/lamejs) (LGPL-3.0) — MP3 encoding for audiobook exports
- [Australian LibriVox Piper voice](https://huggingface.co/DataCraftsmanAustralia/piper-en_AU-librivox-medium) by DataCraftsmanAustralia (CC-BY-4.0)
- [VCTK Corpus](https://datashare.ed.ac.uk/handle/10283/2950) (CC BY 4.0) — regional English accent speakers used by the VCTK Piper voice
- [L2-ARCTIC](https://psi.engr.tamu.edu/l2-arctic-corpus/) (CC BY-NC 4.0) — non-native English accent speakers used by the L2-ARCTIC Piper voice
- [Webster’s English Dictionary](https://github.com/matthewreagan/WebstersEnglishDictionary) — public-domain Webster’s Unabridged 1913 data
- Typefaces: Literata, Merriweather, Lora, EB Garamond, Libre Baskerville, Source Serif 4, Atkinson Hyperlegible, Lexend, Inter, OpenDyslexic and Fraunces (SIL Open Font License), served locally from Fontsource builds.

Built for quiet afternoons and long train rides.
