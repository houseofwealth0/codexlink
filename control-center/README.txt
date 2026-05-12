Codex Link Control Center
=========================

This folder is your local control panel for Codex Link.

Use these files:

1. Start Codex Link.cmd
   Opens one visible terminal that runs:
   - Codex Link Controller
   - Cloudflare Tunnel

   It also opens the dashboard automatically.
   Keep that terminal open while you use Codex Link.

2. Open Dashboard.url
   Opens the local dashboard:
   http://localhost:8787/

3. Check Status.cmd
   Checks whether the controller and Cloudflare Tunnel are reachable.

4. Stop Codex Link.cmd
   Stops the controller on port 8787 and stops Cloudflare Tunnel.
   You can also use the Shut Down Codex Link button in the dashboard.

Project location:
D:\Users\colan\Documents\New project 2

Current Replit install URL:
Use the https URL shown in the dashboard.

Example:
npx --yes github:houseofwealth0/codexlink#main install --controller https://YOUR-TRYCLOUDFLARE-URL --pairing-code YOUR_CODE
