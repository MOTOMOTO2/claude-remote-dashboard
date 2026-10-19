# House relay — add-on

The relay that makes your house reachable from the claude-remote dashboard,
running on the hub itself rather than on your PC.

`DOCS.md` is the full version, and it is what Home Assistant shows on the
add-on's Documentation tab once it is installed.

## Installing it

This is a **local add-on**: it is built on the hub, so it is not installed
from a URL. Two steps.

1. On the machine with this repo:

   ```sh
   npm run addon
   ```

   That copies the four files the relay runs into `bridge/addon/relay`,
   because a local add-on is built with its own folder as the build context
   and cannot reach up into the repo. They are gitignored — one copy of the
   relay lives in the repo, and this script is how it gets to the hub.

2. Copy this whole `bridge/addon` folder into the hub's `addons` share, as a
   folder named `house_relay`. The hub shares one over the network for
   exactly this:

   | | |
   |---|---|
   | Windows | `\\homeassistant\addons` |
   | macOS | `smb://homeassistant/addons` |

   (No share? Install the **Samba share** add-on on the hub first, or use the
   **Advanced SSH & Web Terminal** add-on and `scp` the folder to `/addons`.)

Then on the hub: **Settings → Add-ons → Add-on store → ⋮ → Check for
updates**, and *House relay* appears under **Local add-ons**. Install it,
fill in the Supabase half on its **Configuration** tab, and start it.

Its log should say which relay it is and that it is mirroring the house.
`#/house` on the dashboard goes green within ten seconds, and stays green
with your PC switched off — which is the whole point.

## No Home Assistant OS?

If the Pi runs Raspberry Pi OS with Home Assistant in Docker, or anything
else where systemd is yours to use, there is no add-on store to install into.
Use `bridge/install-on-pi.sh` instead: same relay, as a systemd service.
