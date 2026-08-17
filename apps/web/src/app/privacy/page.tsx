import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Politique de confidentialité — Whauto AI',
  description: 'Comment Whauto AI collecte, utilise et protège les données.',
};

/**
 * Page PUBLIQUE (hors dashboard, sans authentification) — requise par l'App
 * Review Meta. ⚠️ CONTENU DE DÉPART À FAIRE VALIDER JURIDIQUEMENT avant mise en
 * production : il décrit fidèlement le fonctionnement actuel mais n'est pas un
 * avis juridique.
 */
export default function PrivacyPolicyPage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <div className="mb-8 rounded-card border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">
        Modèle de départ — à faire valider par un conseil juridique avant mise en production.
      </div>

      <h1 className="mb-2 text-3xl font-semibold">Politique de confidentialité</h1>
      <p className="mb-8 text-sm text-muted-foreground">Dernière mise à jour : à compléter.</p>

      <div className="space-y-6 text-sm leading-relaxed">
        <section>
          <h2 className="mb-2 text-lg font-semibold">1. Qui sommes-nous</h2>
          <p>
            Whauto AI est une plateforme de commerce conversationnel qui permet aux commerçants de
            gérer leurs échanges WhatsApp Business, leur catalogue, leurs commandes et leurs
            paiements. WhatsApp est une marque de Meta ; Whauto AI n’est pas affilié à Meta.
          </p>
        </section>

        <section>
          <h2 className="mb-2 text-lg font-semibold">2. Données que nous traitons</h2>
          <ul className="list-disc space-y-1 pl-5">
            <li>Compte commerçant : nom, email, organisation, rôle.</li>
            <li>
              Connexion WhatsApp Business : identifiants techniques du numéro et jetons d’accès Meta
              (chiffrés au repos, jamais exposés).
            </li>
            <li>
              Conversations WhatsApp : messages échangés avec les clients, coordonnées de contact,
              paniers, commandes et paiements associés.
            </li>
          </ul>
        </section>

        <section>
          <h2 className="mb-2 text-lg font-semibold">3. Finalités</h2>
          <p>
            Les données sont traitées pour fournir le service : réception et envoi de messages,
            assistance commerciale (y compris assistance par IA), gestion du catalogue, des
            commandes et des paiements, et statistiques destinées au commerçant. Nous n’utilisons pas
            le contenu des conversations pour entraîner des modèles d’IA généraux.
          </p>
        </section>

        <section>
          <h2 className="mb-2 text-lg font-semibold">4. Partage</h2>
          <p>
            Les données transitent par WhatsApp Business Cloud API (Meta) en tant que canal, et par
            les prestataires de paiement choisis par le commerçant. Chaque organisation est isolée :
            aucune donnée n’est partagée entre commerçants.
          </p>
        </section>

        <section>
          <h2 className="mb-2 text-lg font-semibold">5. Conservation et suppression</h2>
          <p>
            Les données sont conservées le temps nécessaire au service. Un commerçant peut demander
            la suppression de ses données ou révoquer la connexion WhatsApp à tout moment ; la
            révocation d’une connexion détruit immédiatement les jetons d’accès Meta associés. Les
            demandes de suppression initiées via Meta sont traitées automatiquement.
          </p>
        </section>

        <section>
          <h2 className="mb-2 text-lg font-semibold">6. Contact</h2>
          <p>Pour toute question relative à vos données : à compléter (adresse email de contact).</p>
        </section>
      </div>
    </main>
  );
}
