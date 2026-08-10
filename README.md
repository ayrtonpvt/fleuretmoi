# Which Flower? — GitHub Pages edition

A personal, static PWA that sends plant photos directly from your browser to the Pl@ntNet API.

## No backend, no database, no LLM

- GitHub Pages hosts the HTML/CSS/JS.
- Your Pl@ntNet API key is entered inside the app and stored in `localStorage` on that browser/device.
- The key is **not** included in this repository.
- Identification history and offline queue are stored locally with IndexedDB.

## Publish on GitHub Pages

1. Create a repository on GitHub.
2. Upload the **contents of this folder** to the repository root (not the ZIP itself).
3. Commit the files.
4. Open **Settings → Pages**.
5. Under **Build and deployment**, choose **Deploy from a branch**.
6. Select branch **main** and folder **/(root)**, then Save.
7. Open the GitHub Pages URL GitHub gives you.
8. In your Pl@ntNet account, enable client/browser use of your API key and allow your GitHub Pages domain/origin for CORS.
9. Open Which Flower on your phone, paste the API key once, and save it.
10. Install the PWA from the browser's “Add to Home screen” / “Install app” command.

## Offline behavior

The app shell, history, and previously stored data work offline. Photos taken offline are kept in IndexedDB and retried when internet returns. Pl@ntNet identification itself still needs internet in this edition.
