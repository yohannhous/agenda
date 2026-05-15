SECUTECH BOOKING — GUIDE DE DÉPLOIEMENT RAILWAY
================================================

ÉTAPE 1 — PRÉPARER LES FICHIERS
---------------------------------
1. Téléchargez ce dossier sur votre ordinateur
2. Ouvrez Railway : railway.app
3. Cliquez "New Project" → "Empty Project"


ÉTAPE 2 — DÉPLOYER SUR RAILWAY
--------------------------------
Option A (recommandée) — Via GitHub :
1. Mettez le dossier sur GitHub (nouveau dépôt)
2. Dans Railway : "Deploy from GitHub"
3. Sélectionnez votre dépôt
4. Railway déploie automatiquement

Option B — Via CLI :
1. Installez Railway CLI : npm install -g @railway/cli
2. Dans le dossier du projet : railway login
3. Puis : railway up


ÉTAPE 3 — AJOUTER LES VARIABLES D'ENVIRONNEMENT
-------------------------------------------------
Dans Railway, allez dans votre projet → "Variables" → ajoutez :

Nom de la variable            : GOOGLE_SERVICE_ACCOUNT_JSON
Valeur                        : (coller tout le contenu du fichier JSON téléchargé depuis Google)

⚠️ Important : coller le JSON sur UNE SEULE LIGNE


ÉTAPE 4 — RÉCUPÉRER L'URL DE VOTRE API
----------------------------------------
Dans Railway → votre projet → "Settings" → "Domains"
Cliquez "Generate Domain"
Vous obtenez une URL comme : https://secutech-booking.railway.app

Testez en ouvrant cette URL dans votre navigateur.
Vous devez voir : {"status":"ok","service":"SECUTECH Booking API"}


ÉTAPE 5 — TESTER L'API
------------------------
Vous pouvez tester avec un outil comme Postman ou directement
depuis votre terminal :

curl -X POST https://VOTRE-URL.railway.app/rdv \
  -H "Content-Type: application/json" \
  -d '{
    "prenom": "Yohann",
    "nom": "Houssenaly",
    "telephone": "0693227268",
    "adresse": "4 rue louis lagourgue duparc",
    "codePostal": "97498",
    "ville": "Sainte Marie",
    "demande": "Installation de caméras",
    "nbProduits": 2
  }'

Si tout fonctionne, le RDV apparaît dans votre Google Calendar.


ROUTES DISPONIBLES
------------------
GET  /           → Vérifie que le serveur fonctionne
POST /rdv        → Crée un RDV dans Google Calendar
GET  /creneau    → Trouve le prochain créneau dispo sans créer de RDV


DURÉE DES RDV
-------------
1 à 4 produits  : 40 minutes
5 produits +    : 1 heure
Intervention    : 1 heure


HORAIRES
--------
Lundi au vendredi : 8h00-12h00 / 14h00-18h00
