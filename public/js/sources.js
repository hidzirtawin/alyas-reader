/* Curated free-book sources. Links open in a new tab; nothing is downloaded
   or bundled by Alya's Reader. Piracy mirrors are intentionally excluded. */

import { modal } from './ui.js';
import { esc, icon } from './util.js';

const GROUPS = [
  {
    title: 'Public-domain libraries',
    blurb: 'Classics and older works that are free to read and keep.',
    items: [
      {
        name: 'Project Gutenberg',
        url: 'https://www.gutenberg.org',
        host: 'gutenberg.org',
        desc: 'Over 70,000 public-domain ebooks in EPUB, Kindle and plain text.',
      },
      {
        name: 'Standard Ebooks',
        url: 'https://standardebooks.org',
        host: 'standardebooks.org',
        desc: 'Carefully edited, beautifully typeset public-domain classics.',
      },
      {
        name: 'Planet eBook',
        url: 'https://www.planetebook.com',
        host: 'planetebook.com',
        desc: 'Free classic novels as clean, printable PDFs.',
      },
      {
        name: 'Internet Archive',
        url: 'https://archive.org/details/texts',
        host: 'archive.org',
        desc: 'Millions of scanned books, many available to borrow or download.',
      },
      {
        name: 'Open Library',
        url: 'https://openlibrary.org',
        host: 'openlibrary.org',
        desc: 'A catalogue of books with free borrowing and public-domain downloads.',
      },
      {
        name: 'Feedbooks',
        url: 'https://www.feedbooks.com',
        host: 'feedbooks.com',
        desc: 'Public-domain catalogue with EPUB and Kindle editions.',
      },
      {
        name: 'ManyBooks',
        url: 'https://manybooks.net',
        host: 'manybooks.net',
        desc: 'Thousands of free classics and indie titles in every major format.',
      },
      {
        name: 'PDF Books World',
        url: 'https://www.pdfbooksworld.com',
        host: 'pdfbooksworld.com',
        desc: 'Free public-domain PDF books, including illustrated classics.',
      },
    ],
  },
  {
    title: 'Free & discounted ebooks',
    blurb: 'Legal freebies, samples and low-cost deals from authors and publishers.',
    items: [
      {
        name: 'Free-eBooks.net',
        url: 'https://www.free-ebooks.net',
        host: 'free-ebooks.net',
        desc: 'Free ebooks across fiction, business, self-help and more.',
      },
      {
        name: 'BookBoon',
        url: 'https://bookboon.com',
        host: 'bookboon.com',
        desc: 'Free student and business ebooks from a publisher-backed library.',
      },
      {
        name: 'Smashwords',
        url: 'https://www.smashwords.com',
        host: 'smashwords.com',
        desc: 'Independent authors, with a large filterable free section.',
      },
      {
        name: 'Obooko',
        url: 'https://www.obooko.com',
        host: 'obooko.com',
        desc: 'Free indie ebooks in EPUB, PDF and Kindle formats.',
      },
      {
        name: 'Open Culture',
        url: 'https://www.openculture.com/free_ebooks',
        host: 'openculture.com',
        desc: 'A hand-picked directory of free ebook collections.',
      },
      {
        name: 'Elejandría',
        url: 'https://www.elejandria.com',
        host: 'elejandria.com',
        desc: 'Free public-domain literature in Spanish.',
      },
    ],
  },
  {
    title: 'Audiobooks, catalogues & deals',
    blurb: 'Find a title, follow an author, or listen instead of reading.',
    items: [
      {
        name: 'LibriVox',
        url: 'https://librivox.org',
        host: 'librivox.org',
        desc: 'Volunteer-read public-domain audiobooks, free to download.',
      },
      {
        name: 'Audible',
        url: 'https://www.audible.com',
        host: 'audible.com',
        desc: 'Subscription audiobooks read by professional human narrators.',
      },
      {
        name: 'Goodreads',
        url: 'https://www.goodreads.com',
        host: 'goodreads.com',
        desc: 'Catalogue, reviews and reading lists — not a download store.',
      },
      {
        name: 'BookBub',
        url: 'https://www.bookbub.com',
        host: 'bookbub.com',
        desc: 'Daily ebook deals and free promotions for your favourite genres.',
      },
      {
        name: 'Google Books',
        url: 'https://books.google.com',
        host: 'books.google.com',
        desc: 'Preview and search millions of books; many older titles are full-view.',
      },
      {
        name: 'FreeComputerBooks',
        url: 'https://freecomputerbooks.com',
        host: 'freecomputerbooks.com',
        desc: 'Free programming, maths and computer-science ebooks.',
      },
    ],
  },
  {
    title: 'Borrow with a library card',
    blurb: 'Free library loans of ebooks and audiobooks, including human narration.',
    items: [
      {
        name: 'Libby',
        url: 'https://libbyapp.com',
        host: 'libbyapp.com',
        desc: 'Borrow ebooks and audiobooks from your local library with a card.',
      },
      {
        name: 'OverDrive',
        url: 'https://www.overdrive.com',
        host: 'overdrive.com',
        desc: 'Find your library’s digital collection and borrow on any device.',
      },
    ],
  },
];

const PENDING_KEY = 'alya.pendingDownload';

export function rememberDownloadSource(source) {
  try {
    localStorage.setItem(PENDING_KEY, JSON.stringify({ source, at: Date.now() }));
  } catch {}
}

function readPending() {
  try {
    const rec = JSON.parse(localStorage.getItem(PENDING_KEY) || 'null');
    return rec && rec.at ? rec : null;
  } catch { return null; }
}

export function clearPendingDownload() {
  try { localStorage.removeItem(PENDING_KEY); } catch {}
  document.getElementById('downloadPrompt')?.remove();
}

function showDownloadPrompt(pending) {
  if (document.getElementById('downloadPrompt')) return;
  const node = document.createElement('div');
  node.id = 'downloadPrompt';
  node.className = 'download-prompt';
  node.innerHTML = `
    <div class="dp-icon">${icon('book')}</div>
    <div class="dp-copy">
      <strong>Got a book from ${esc(pending.source || 'a free library')}?</strong>
      <span>Choose the downloaded file and it joins your library.</span>
    </div>
    <button class="btn btn-sm btn-primary" data-dp-add>Add book</button>
    <button class="icon-btn" data-dp-dismiss aria-label="Not now">${icon('x')}</button>`;
  node.querySelector('[data-dp-add]').addEventListener('click', () => {
    clearPendingDownload();
    document.querySelector('#fileInput')?.click();
  });
  node.querySelector('[data-dp-dismiss]').addEventListener('click', clearPendingDownload);
  document.body.appendChild(node);
}

/* Browsers cannot see files downloaded by another tab, so when the reader
   returns to the app we offer the file picker instead of guessing. */
export function maybeOfferDownloadedBook() {
  if (document.getElementById('downloadPrompt')) return;
  if (document.querySelector('.modal-backdrop')) return;
  if (document.querySelector('#reader.is-open')) return;
  const pending = readPending();
  if (!pending) return;
  const age = Date.now() - pending.at;
  if (age < 2500) return;
  if (age > 12 * 60 * 60 * 1000) { clearPendingDownload(); return; }
  setTimeout(() => {
    if (!readPending() || document.querySelector('.modal-backdrop') || document.querySelector('#reader.is-open')) return;
    showDownloadPrompt(pending);
  }, 600);
}

export function openBookSources() {
  const body = document.createElement('div');
  body.className = 'sources';
  body.innerHTML = `
    <p class="sources-intro">
      Free and legal places to find your next book. Each link opens in a new tab.
      When you come back with a file, Alya’s Reader will offer to add it to your library.
    </p>
    ${GROUPS.map(group => `
      <section class="source-group">
        <h3>${esc(group.title)}</h3>
        <p class="source-blurb">${esc(group.blurb)}</p>
        <div class="source-grid">
          ${group.items.map(item => `
            <a class="source-card" href="${esc(item.url)}" target="_blank" rel="noopener noreferrer" data-source="${esc(item.name)}">
              <span class="source-name">${esc(item.name)}${icon('arrow-right')}</span>
              <span class="source-desc">${esc(item.desc)}</span>
              <span class="source-host">${esc(item.host)}</span>
            </a>`).join('')}
        </div>
      </section>`).join('')}
    <p class="sources-note">
      <strong>Not linked here:</strong> Library Genesis, Z-Library, Anna’s Archive,
      PDF Drive, Ocean of PDF, PDF Room and similar mirrors. They distribute
      copyrighted books without permission, so this reader does not point to them.
    </p>`;

  modal({
    eyebrow: 'Find something to read',
    title: 'Free book sources',
    subtitle: 'Public-domain classics, free-licensed books and deals — opens in a new tab.',
    body,
    wide: true,
    foot: `<div style="display:flex;align-items:center;gap:10px;width:100%;flex-wrap:wrap">
      <button class="btn btn-sm btn-primary" id="sourcesAdd">${icon('upload')} Add a downloaded book</button>
      <span class="hint" style="margin-left:auto">EPUB · PDF · DOCX · TXT · CBZ · CBR</span>
    </div>`,
    onMount: ({ bodyEl, footEl, close }) => {
      bodyEl.querySelectorAll('.source-card').forEach(card => {
        card.addEventListener('click', () => {
          rememberDownloadSource(card.dataset.source || 'a free library');
          // Keep the picker ready for when they return from the site.
          close('source');
        });
      });
      footEl?.querySelector('#sourcesAdd')?.addEventListener('click', () => {
        close('add');
        document.querySelector('#fileInput')?.click();
      });
    },
  });
}
