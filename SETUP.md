# ThreadTrace setup

## Run locally (VS Code PowerShell)
    $env:PORT=3000; python server.py
Open http://localhost:3000   (hard refresh: Ctrl+Shift+R after every update)

## What works without any setup
- Login page first, Email login (demo), Fingerprint login (https or localhost)
- Name + mobile profile form, Policy & Settings, Log out, Expected Mail rules (saved on device)
- Evidence: real PDF + JSON download with a real SHA-256 hash

## Google login ("Continue with Google")  -- needs a free Client ID
1. console.cloud.google.com -> create project
2. APIs & Services -> OAuth consent screen -> External -> add yourself under Test users
3. Credentials -> Create credentials -> OAuth client ID -> Web application
4. Authorized JavaScript origins: add BOTH
      http://localhost:3000
      https://threadtrace.netlify.app      (your real Netlify URL)
5. Copy the Client ID and paste it in config.js:   googleClientId: "xxxx.apps.googleusercontent.com"
6. Redeploy (drag the folder to Netlify again). The Google button then appears on the login page.
After Google login the email + name come from Google, then the app asks for the mobile number once.

## Email code to your inbox (needs server.py hosted; Netlify static cannot send mail)
1. Gmail -> Security -> 2-Step Verification ON -> App passwords -> create one
2. Copy .env.example to .env and set SMTP_USER and SMTP_PASS
3. python server.py -> terminal must say "Email alerts: ON"
Host server.py on Render/Railway if you want this online.

## Mobile app
A) PWA: open the https link in Chrome on Android -> menu -> Install app
B) APK with Capacitor: npm i @capacitor/core @capacitor/cli @capacitor/android ; npx cap init ; copy files to www ; npx cap add android ; npx cap open android
