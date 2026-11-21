# ICAOdle

A daily airport guessing game: five rounds a day, you see an airport on a satellite map (or just its city and state) and guess its ICAO code. Easy, Medium and Hard daily sets are the same for everyone; a Custom game gives you random practice rounds, optionally in one state.

## Run it with Docker Compose

1. Get a Google Maps JavaScript API key (Google Cloud Console, billing enabled) and restrict it to your site's address under "HTTP referrers".
2. Copy the settings file and add the key:
   ```sh
   cp .env.example .env
   # edit .env: GOOGLE_MAPS_KEY=...
   ```
3. Start it:
   ```sh
   docker compose up -d --build
   ```
4. Open `http://<your-server>:3000` (or the `HOST_PORT` you set in `.env`).

| Setting (`.env`) | Meaning |
|---|---|
| `GOOGLE_MAPS_KEY` | Required. Served to the browser by the app; it never goes in the image or the repo. |
| `HOST_PORT` | Port on your server (default 3000). |

The container listens on plain HTTP. For HTTPS, put a reverse proxy in front (Caddy, nginx, Traefik) and point it at the container's port 3000.

**Data.** The daily sets and everyone's scores are saved in the `icaodle-data` Docker volume (`/data/data.json` inside the container), so they survive restarts and rebuilds. Back it up with:
```sh
docker run --rm -v icaodle_icaodle-data:/data -v "$PWD":/backup alpine cp /data/data.json /backup/data.json
```

**Updating.** `git pull && docker compose up -d --build`. New daily sets are generated automatically at midnight UTC.

**Sounds.** The game uses the built-in sound pack plus any `correct.wav`, `wrong.wav`, `lost.wav`, `skip.wav`, `finish.wav` or `flap.wav` in `sounds/` (see `sounds/README.md`). To swap files without rebuilding, uncomment the `./sounds` volume line in `docker-compose.yml`.

## Run it without Docker

```sh
npm install
GOOGLE_MAPS_KEY=... node server.js     # or put it in a .env file
npm test                               # sound-module unit tests
```

`node build-airports.js` rebuilds `airports.json` from the OurAirports data.
