
A personal, static PWA that sends plant photos directly from my browser to the Pl@ntNet API.


- GitHub Pages hosts the HTML/CSS/JS.
- Your Pl@ntNet API key is entered inside the app and stored in `localStorage` on that browser/device.
- The key is **not** included in this repository.
- Identification history and offline queue are stored locally with IndexedDB.



## Offline behavior

The app shell, history, and previously stored data work offline. Photos taken offline are kept in IndexedDB and retried when internet returns. Pl@ntNet identification itself still needs internet in this edition.
