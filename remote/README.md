# Relais Axecode Remote (auto-hébergé)

Ce dossier contient le petit relais qui permet de piloter Axecode depuis un
téléphone. C'est **la seule pièce à héberger** : l'application de bureau tourne
sur votre PC, la PWA mobile est servie par ce relais. Aucun relais public n'est
fourni : vous déployez le vôtre, puis vous saisissez son URL dans
**Settings > Remote** (champ « Relais », vide par défaut — Remote reste inactif
tant qu'il n'est pas renseigné).

Rôle du relais :

- garder une WebSocket sortante ouverte par l'application de bureau ;
- router des trames chiffrées opaques entre un téléphone appairé et ce PC ;
- servir la PWA mobile (`public/`) ;
- envoyer des notifications Web Push génériques quand le PC signale un tour terminé.

Il ne déchiffre jamais le contenu du chat : la réponse d'appairage et toutes les
commandes/événements sont des enveloppes AEAD entre le téléphone et le PC.

## Déploiement Docker (recommandé)

Prérequis : un serveur avec Docker + Docker Compose et un nom de domaine
pointant dessus (ex. `relay.exemple.fr`).

```bash
git clone <ce dépôt> axecode && cd axecode/remote
# Optionnel : notifications push
npx web-push generate-vapid-keys   # puis renseigner .env (jamais commité)
cat > .env <<'EOF'
VAPID_PUBLIC_KEY=...
VAPID_PRIVATE_KEY=...
VAPID_SUBJECT=mailto:vous@exemple.fr
EOF
docker compose up -d --build
curl http://127.0.0.1:8787/healthz   # → {"ok":true}
```

Le conteneur écoute sur le port **8787**, publié uniquement sur `127.0.0.1` :
seul le reverse proxy de la machine y accède. Le healthcheck interroge `/healthz`.

### Reverse proxy TLS

Le relais doit être exposé en **HTTPS/WSS** (le téléphone installe la PWA et
l'application de bureau se connecte à `wss://<domaine>/ws`). Exemple Caddy
(certificat Let's Encrypt automatique, WebSocket géré nativement) :

```caddyfile
relay.exemple.fr {
    reverse_proxy 127.0.0.1:8787
}
```

Exemple nginx :

```nginx
server {
    listen 443 ssl http2;
    server_name relay.exemple.fr;
    ssl_certificate     /etc/letsencrypt/live/relay.exemple.fr/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/relay.exemple.fr/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 1h;
    }
}
```

### Côté application

1. **Settings > Remote → Relais** : saisir `https://relay.exemple.fr`
   (converti automatiquement en `wss://relay.exemple.fr/ws`), puis Enregistrer.
2. Activer Remote, puis **Ouvrir l'appairage** et scanner le QR code avec le téléphone.

## Variables d'environnement

| Variable | Défaut | Rôle |
| --- | --- | --- |
| `PORT` | `8787` | port d'écoute HTTP/WebSocket |
| `HOST` | `0.0.0.0` | adresse d'écoute dans le conteneur |
| `VAPID_PUBLIC_KEY` | vide | clé publique Web Push |
| `VAPID_PRIVATE_KEY` | vide | clé privée Web Push (secret) |
| `VAPID_SUBJECT` | `mailto:admin@localhost` | contact VAPID |

Sans clés VAPID, le relais fonctionne : seules les notifications push sont
désactivées (chat, streaming et appairage ne sont pas affectés).

## Exécution sans Docker

```bash
cd remote
npm install
npm start
# → http://localhost:8787
```

## Exploitation

- **Une seule instance.** L'état de routage (PC connectés, codes d'appairage)
  est en mémoire : plusieurs réplicas sépareraient un téléphone de son PC.
- **Aucune base, aucun volume.** Rien n'est persisté ; après un redémarrage, le
  PC et le téléphone se reconnectent et reprennent le streaming.
- **Sécurité.** Ne publiez pas le port 8787 directement sur Internet : passez
  par le reverse proxy TLS. Les clés VAPID vont dans `.env`, jamais dans le dépôt.
