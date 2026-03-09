# NCAA Conference Brackets

Live 2026 NCAA conference tournament brackets. No hardcoded team names, seeds, scores, or records — all bracket data is fetched live from ESPN's public API at runtime.

## Project structure

```
├── index.html              # Shell markup — no hardcoded conference data
├── package.json
└── src/
    ├── conferences.json    # ← ONLY file you ever need to edit
    ├── main.js             # App entry: wires sidebar, switching, refresh
    ├── espn.js             # ESPN API fetch + bracket data transformation
    ├── render.js           # DOM rendering, layout alignment, SVG connectors
    └── styles.css          # All styles
```

## Getting started

```bash
npm install
npm run dev       # dev server at http://localhost:5173
npm run build     # production build → dist/
npm run preview   # preview production build
```

## Adding or editing a conference

Open `src/conferences.json` and add an entry:

```json
{
  "id": "bigten",
  "name": "Big Ten",
  "dates": "Mar 12–16",
  "espnGroupId": "4",
  "accent": "#003087",
  "accentHi": "#4a7cc7",
  "accentDim": "rgba(0,48,135,0.13)",
  "sponsor": "2026 Big Ten Conference",
  "titleHTML": "2026 <em>Big Ten</em> Men's Basketball Tournament",
  "sub": "March 12–16, 2026 · Gainbridge Fieldhouse, Indianapolis",
  "footerDisc": "All games on Peacock, CBS, or Big Ten Network",
  "footerLinks": "BigTen.org &nbsp;|&nbsp; #B1GMBBall",
  "espnDateRange": "20260312-20260316"
}
```

That's it — the sidebar button, header, colors, and bracket data all appear automatically.

## Finding ESPN group IDs

Go to `https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/scoreboard?limit=1`
and search for the conference. Or look up the group ID in ESPN URLs like:
`https://www.espn.com/mens-college-basketball/scoreboard/_/group/4` — the number after `/group/` is the group ID.
