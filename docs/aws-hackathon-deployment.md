# AWS hackathon deployment

This setup uses one small Ubuntu Lightsail instance for the Node backend,
Next.js dashboard, and Caddy HTTPS proxy. PostgreSQL stays on the existing
managed Supabase database. The public repository uses GitHub Releases for the
Windows installer and update files, so no S3 bucket is needed for updates.

## One-time setup

1. Replace any AWS root access keys with a scoped IAM identity before creating
   infrastructure.
2. Create an Ubuntu Lightsail instance in Mumbai with at least 2 GB RAM, attach
   a static IP, and allow TCP ports 22, 80, and 443.
3. SSH into the instance and run `sudo bash /opt/ari/ops/aws/bootstrap-ubuntu.sh`
   after cloning the repository, or copy the script to the new instance first.
4. Copy `ops/aws/production.env.example` to `/opt/ari/.env.production`, replace
   the example IP and secrets, and keep this file only on the server.
5. In Google Cloud Console, add the exact HTTPS callback from
   `GOOGLE_DASHBOARD_REDIRECT_URI` as an authorized redirect URI.
6. Run `cd /opt/ari && bash ops/aws/deploy.sh`.

The free `sslip.io` hostname shown in the template resolves to the static IP,
which lets Caddy obtain a valid TLS certificate without buying a domain.

## Automatic deployments

Add these GitHub Actions secrets:

- `LIGHTSAIL_HOST`: the static public IP
- `LIGHTSAIL_SSH_KEY`: the private SSH deployment key
- `LIGHTSAIL_KNOWN_HOSTS`: the verified SSH host-key line

Every push to `main` then validates the project and updates the instance. The
database migration runs before the new containers replace the old ones.

## Windows installer and updates

Set the repository variable `ARI_DESKTOP_DASHBOARD_URL` to the dashboard HTTPS
URL. Increment `desktop/package.json`'s version and push the matching tag (for
example `v0.2.0`). GitHub Actions publishes the installer plus `latest.yml`.
Existing installations check GitHub Releases after launch, download updates in
the background, and install them when the app exits.

Dashboard and backend changes do not require a new EXE. Only changes to native
Electron code require a version bump and desktop release.
