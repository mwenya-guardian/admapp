# Brand assets

## Logo

Place the app logo here:

- `logo.png` — used in the in-app header (`/brand/logo.png`)

## PWA icons

Generated PNGs live in `/public/icons/` (192, 384, 512, maskable, favicon). Regenerate after replacing the logo:

```powershell
py -m pip install pillow
py scripts/generate-icons.py
```

The web manifest references `/icons/*` for install / home-screen icons.
