## Minimalist Notebook

Local-first note taking UI focused on backlinks and automatic metadata. Notes live entirely in the browser (persisted via `localStorage`), making it ideal for a single user who wants a lightweight experience across desktop and mobile.

### Features

- Single-column, brutalist UI: centered 650px text column with only black, white, and International Orange accents.
- Inline Markdown editing: raw text stays visible, and `[[wiki links]]` are colored/clickable (`Cmd/Ctrl + Click` jumps to the target note).
- Command palette (`Cmd/Ctrl + K`) to jump between notes or create a new one instantly.
- Inline link autocomplete: typing `[[` suggests existing note titles or lets you create a new target.
- Backlinks list at the bottom that shows every note referencing the current one.
- Autosave (800 ms debounce) with created/updated timestamps and word counts for each note.

### Architecture

- **Storage**: Plain JavaScript objects persisted with `localStorage` (`notebook-notes` key). Each note contains `{ id, title, content, metadata }`.
- **Metadata**: Generated in `app.js` when a note is created or updated. Tags follow the pattern `#yyyy-mm-dd`, `#hh:mm`, and `#weekday`.
- **Backlinks**: Detected by scanning every note for `[[Title]]` references whenever a note is selected. The list of referencing notes is rendered at the bottom of the page.
- **UI**: Static HTML (`index.html`) + CSS for the brutalist single-column layout plus a keyboard-driven command palette. JavaScript is framework-free to keep bundle size tiny and easy to host anywhere.

### Getting started

1. Open `index.html` in any modern browser (double-clicking the file works).
2. Start typing—autosave keeps everything up to date. Use `Cmd/Ctrl + K` to jump between notes or create new ones.
3. Link notes with the `[[Title]]` syntax; `Cmd/Ctrl + Click` a link to open that note immediately. Backlinks appear at the bottom of the page.
4. Everything stays local via `localStorage`, so no setup is required.

### PWA & offline install

1. Serve the folder with any static file host (e.g. `python3 -m http.server` locally or deploy to GitHub Pages/Netlify).
2. Visit the page and your browser will offer an “Install” / “Add to Home Screen” option.
3. The service worker precaches the HTML, CSS, JS, manifest, and icon so everything works offline after the first load.

### Mobile + quick capture ideas

This prototype already works offline on mobile browsers (load `index.html` via any static hosting). To make sharing easier:

1. Convert it into a Progressive Web App so it can be “installed” and accept incoming shares via the Web Share Target API.
2. Add a `/share` route that accepts URL/query payloads so mobile shortcuts can prefill note content.
3. Long-term, create a lightweight sync backend (Supabase/pocketbase) so desktop & phone stay in lockstep.

Happy writing!
