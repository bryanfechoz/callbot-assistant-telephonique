#!/bin/bash
# ═══════════════════════════════════════════════════════════
# push-to-github.sh
# Crée le repo GitHub "callbot-assistant-telephonique" et pousse le projet
# Usage : bash push-to-github.sh VOTRE_TOKEN_GITHUB
# ═══════════════════════════════════════════════════════════

set -e

GITHUB_USER="bryanfechoz"
REPO_NAME="callbot-assistant-telephonique"
TOKEN="${1}"

if [ -z "$TOKEN" ]; then
  echo ""
  echo "❌  Manque le token GitHub."
  echo ""
  echo "   1. Va sur https://github.com/settings/tokens/new"
  echo "   2. Note : 'AssistantPro deploy'"
  echo "   3. Coche la case 'repo' (accès complet aux repos)"
  echo "   4. Génère le token et copie-le"
  echo ""
  echo "   Puis relance : bash push-to-github.sh ghp_XXXXX"
  echo ""
  exit 1
fi

echo ""
echo "📦 Création du repo GitHub : $REPO_NAME..."

# Créer le repo via l'API GitHub
HTTP_CODE=$(curl -s -o /tmp/gh_response.json -w "%{http_code}" \
  -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  https://api.github.com/user/repos \
  -d "{
    \"name\": \"$REPO_NAME\",
    \"description\": \"Callbot vocal IA pour TPE/PME — ElevenLabs + Google Calendar + Google Drive\",
    \"private\": false,
    \"auto_init\": false
  }")

if [ "$HTTP_CODE" = "201" ]; then
  echo "✅  Repo créé avec succès !"
elif [ "$HTTP_CODE" = "422" ]; then
  echo "ℹ️   Le repo existe déjà, on continue avec le push..."
else
  echo "❌  Erreur HTTP $HTTP_CODE lors de la création du repo"
  cat /tmp/gh_response.json
  exit 1
fi

# Configurer le remote et pousser
REMOTE_URL="https://$TOKEN@github.com/$GITHUB_USER/$REPO_NAME.git"

# Aller dans le dossier projet (adapter le chemin si nécessaire)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Vérifier qu'on est bien dans un repo git
if [ ! -d ".git" ]; then
  echo "❌  Pas de repo git trouvé dans $SCRIPT_DIR"
  echo "   Lance ce script depuis le dossier racine du projet."
  exit 1
fi

# Ajouter ou mettre à jour le remote
git remote remove origin 2>/dev/null || true
git remote add origin "$REMOTE_URL"

echo "🚀 Push vers GitHub..."
git push -u origin main

echo ""
echo "═══════════════════════════════════════════════════════"
echo "✅  Projet disponible sur :"
echo "   https://github.com/$GITHUB_USER/$REPO_NAME"
echo ""
echo "Pour cloner et travailler avec Claude Code :"
echo "   git clone https://github.com/$GITHUB_USER/$REPO_NAME"
echo "   cd $REPO_NAME"
echo "   claude"
echo "═══════════════════════════════════════════════════════"
