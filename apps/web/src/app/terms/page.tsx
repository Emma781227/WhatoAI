import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Conditions d’utilisation — Whauto AI',
  description: 'Conditions d’utilisation du service Whauto AI.',
};

/**
 * Page PUBLIQUE (hors dashboard, sans authentification) — requise par l'App
 * Review Meta. ⚠️ CONTENU DE DÉPART À FAIRE VALIDER JURIDIQUEMENT avant mise en
 * production.
 */
export default function TermsPage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <div className="mb-8 rounded-card border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">
        Modèle de départ — à faire valider par un conseil juridique avant mise en production.
      </div>

      <h1 className="mb-2 text-3xl font-semibold">Conditions d’utilisation</h1>
      <p className="mb-8 text-sm text-muted-foreground">Dernière mise à jour : à compléter.</p>

      <div className="space-y-6 text-sm leading-relaxed">
        <section>
          <h2 className="mb-2 text-lg font-semibold">1. Objet</h2>
          <p>
            Whauto AI fournit aux commerçants une plateforme de commerce conversationnel connectée à
            WhatsApp Business. En utilisant le service, vous acceptez les présentes conditions.
          </p>
        </section>

        <section>
          <h2 className="mb-2 text-lg font-semibold">2. Compte et connexion WhatsApp</h2>
          <p>
            Vous êtes responsable de l’exactitude des informations de votre compte et de la connexion
            de votre numéro WhatsApp Business. Vous devez disposer des droits nécessaires sur le
            numéro et le catalogue que vous connectez.
          </p>
        </section>

        <section>
          <h2 className="mb-2 text-lg font-semibold">3. Usage acceptable</h2>
          <p>
            Vous vous engagez à respecter les politiques de WhatsApp et de Meta, à ne pas envoyer de
            messages non sollicités et à n’utiliser le service qu’à des fins commerciales légitimes.
          </p>
        </section>

        <section>
          <h2 className="mb-2 text-lg font-semibold">4. Assistance par IA</h2>
          <p>
            Le service peut proposer ou envoyer des réponses générées par IA selon la configuration
            que vous choisissez. Les données déterminantes (prix, stock, commandes, paiements)
            proviennent toujours des services métier, jamais de l’IA seule.
          </p>
        </section>

        <section>
          <h2 className="mb-2 text-lg font-semibold">5. Paiements</h2>
          <p>
            Les paiements sont traités par les prestataires que vous sélectionnez. Whauto AI n’est
            pas responsable des litiges relevant directement de ces prestataires.
          </p>
        </section>

        <section>
          <h2 className="mb-2 text-lg font-semibold">6. Résiliation</h2>
          <p>
            Vous pouvez cesser d’utiliser le service et déconnecter WhatsApp à tout moment. Nous
            pouvons suspendre un compte en cas de violation des présentes conditions.
          </p>
        </section>

        <section>
          <h2 className="mb-2 text-lg font-semibold">7. Contact</h2>
          <p>Pour toute question : à compléter (adresse email de contact).</p>
        </section>
      </div>
    </main>
  );
}
