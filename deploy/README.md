# VPS Deployment Notes

This template assumes the contents of `Game Library` are deployed to:

```text
/var/www/minigame-library
```

The public routes are:

- `/` -> `lobby/`
- `/urban-hunt/` -> Urban Hunt Express server on `127.0.0.1:3000`
- `/jetlag/` -> Jetlag Mobile static build
- `/jetlag-api/` and `/jetlag-ws` -> Jetlag Mobile server on `127.0.0.1:8080`
- `/deduction-board/` -> Deduction Board static build
- `/deduction-sync/` -> Deduction Board server on `127.0.0.1:3001`

Run `bash deploy/build-all.sh` on the VPS to build all three apps with the right base paths.

After copying the systemd files to `/etc/systemd/system/`, update secrets such as
`ADMIN_PIN`, make sure `www-data` can write the app data/state directories, then run:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now urban-hunt jetlag-mobile-server jetlag-deduction-server
sudo nginx -t
sudo systemctl reload nginx
```

Use Certbot or your existing TLS tooling to add HTTPS for the configured domain.
