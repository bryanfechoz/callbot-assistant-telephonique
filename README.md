# Assistant Téléphonique — AssistantPro

Callbot vocal IA pour TPE/PME et artisans. Répond aux appels 24h/24, prend les rendez-vous, gère les urgences, sauvegarde les comptes-rendus.

## Structure du projet

```
assistantpro/
├── site/               # Page de démo (demo.venusweb.fr)
│   ├── index.html      # Site complet — un seul fichier à uploader
│   └── brand_visual.png
├── webhook/            # Serveur Node.js → Google Calendar
│   ├── server.js       # Webhook principal
│   ├── package.json
│   └── .env.example    # Variables d'environnement à configurer
├── design/
│   └── philosophy.md   # Philosophie visuelle "Signal Humain"
└── README.md
```

## Stack technique

- **Agent vocal** : ElevenLabs (ID: `agent_8701kp8gm1djf0dvn1ar278jj9m1`)
- **Webhook** : Node.js + Express
- **Calendrier** : Google Calendar API (Service Account)
- **Stockage** : Google Drive API
- **Hébergement webhook** : Railway.app (recommandé)
- **Hébergement site** : demo.venusweb.fr

## Démarrage rapide

### Site de démo
Uploader `site/index.html` sur `demo.venusweb.fr`. C'est tout.

### Webhook Google Calendar
```bash
cd webhook
cp .env.example .env
# Remplir les variables dans .env
npm install
npm start
```

## Variables d'environnement

Voir `webhook/.env.example` pour la liste complète.

| Variable | Description |
|---|---|
| `GOOGLE_CLIENT_EMAIL` | Email du Service Account |
| `GOOGLE_PRIVATE_KEY` | Clé privée JSON |
| `GOOGLE_CALENDAR_ID` | ID du calendrier cible |
| `ELEVENLABS_WEBHOOK_SECRET` | Secret partagé ElevenLabs |

## Tarification du service

| Plan | Prix | Fonctionnalités |
|---|---|---|
| Essentiel | 149€/mois | Réception + messages + filtrage |
| Pro | 199€/mois | + RDV + Calendar + Drive |
| Premium | 299€/mois | + CRM + SMS + rapports |

## Roadmap

- [ ] Intégration SMS (Twilio) pour confirmation client
- [ ] Sauvegarde comptes-rendus dans Google Drive
- [ ] Dashboard de suivi des appels
- [ ] Multi-profils (plombier, électricien, etc.)
- [ ] Intégration CRM (HubSpot, Pipedrive)
