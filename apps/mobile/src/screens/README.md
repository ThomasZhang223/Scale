# src/screens — not used

Routes live in `apps/mobile/app/`, because expo-router is file-based: a file at
`app/scan/room.jsx` *is* the `/scan/room` route. Putting screens anywhere else means wiring
navigation by hand, which is the thing expo-router exists to avoid.

Put shared, non-route components here if a screen grows too big for one file. Otherwise leave
this directory empty.
