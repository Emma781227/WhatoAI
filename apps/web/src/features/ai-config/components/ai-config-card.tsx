'use client';

import { Loader2, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { ErrorState } from '@/components/feedback/error-state';
import { getErrorMessage } from '@/lib/api/api-error';
import { PERMISSIONS } from '@/lib/permissions/constants';
import { usePermissions } from '@/lib/permissions/use-permissions';
import { cn } from '@/lib/utils';

import {
  AI_AUTO_REPLY_CATEGORIES,
  type AiConfiguration,
  type AiMode,
  type AiScheduleMode,
} from '../api';
import { useAiConfig, useUpdateAiConfig } from '../use-ai-config';

const MODE_LABELS: Record<AiMode, string> = {
  DISABLED: 'Désactivé',
  SUGGEST_ONLY: 'Suggestions (validation humaine)',
  AUTO_REPLY: 'Réponse automatique',
};
const SCHEDULE_LABELS: Record<AiScheduleMode, string> = {
  ALWAYS: 'En continu (24/7)',
  OUTSIDE_BUSINESS_HOURS: 'Hors horaires d’ouverture',
};
const CATEGORY_LABELS: Record<string, string> = {
  PRODUCT_INFO: 'Infos produit',
  AVAILABILITY: 'Disponibilité',
  OPENING_HOURS: 'Horaires',
  ORDER_STATUS: 'Statut commande',
};

export function AiConfigCard({ shopId }: { shopId: string }) {
  const query = useAiConfig(shopId);

  if (query.isPending) {
    return (
      <Card>
        <CardHeader>
          <Skeleton className="h-6 w-40" />
        </CardHeader>
        <CardContent>
          <Skeleton className="h-24 w-full" />
        </CardContent>
      </Card>
    );
  }
  if (query.isError) {
    return (
      <Card>
        <CardContent className="pt-6">
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        </CardContent>
      </Card>
    );
  }
  return <AiConfigForm shopId={shopId} config={query.data} />;
}

function AiConfigForm({ shopId, config }: { shopId: string; config: AiConfiguration }) {
  const { can } = usePermissions();
  const canConfigure = can(PERMISSIONS.AI_CONFIGURE);
  const canEnableAuto = can(PERMISSIONS.AI_ENABLE_AUTO_REPLY);
  const update = useUpdateAiConfig(shopId);

  const [mode, setMode] = useState<AiMode>(config.mode);
  const [autoReplyEnabled, setAutoReplyEnabled] = useState(config.autoReplyEnabled);
  const [scheduleMode, setScheduleMode] = useState<AiScheduleMode>(config.autoReplyScheduleMode);
  const [maxPerDay, setMaxPerDay] = useState(String(config.autoReplyMaxPerConversationPerDay));
  const [categories, setCategories] = useState<string[]>(config.autoReplyAllowedCategories);

  const showAutoReplySettings = mode === 'AUTO_REPLY';

  const toggleCategory = (cat: string) => {
    setCategories((prev) => (prev.includes(cat) ? prev.filter((c) => c !== cat) : [...prev, cat]));
  };

  const save = () => {
    const parsedMax = Number.parseInt(maxPerDay, 10);
    update.mutate(
      {
        mode,
        autoReplyEnabled,
        autoReplyScheduleMode: scheduleMode,
        autoReplyMaxPerConversationPerDay: Number.isFinite(parsedMax) ? parsedMax : 5,
        autoReplyAllowedCategories: categories,
        expectedVersion: config.version,
      },
      {
        onSuccess: () => toast.success('Configuration IA enregistrée.'),
        onError: (error) => toast.error(getErrorMessage(error)),
      },
    );
  };

  return (
    <Card data-testid="ai-config-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Sparkles aria-hidden className="h-4 w-4 text-[#7C3AED]" />
          Assistant IA
        </CardTitle>
        <CardDescription>
          L’IA qualifie le besoin client et recommande des produits. Les prix, stocks et commandes
          viennent toujours des données métier — jamais inventés.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Mode */}
        <div className="space-y-1.5">
          <Label htmlFor="ai-mode">Mode</Label>
          <Select
            value={mode}
            onValueChange={(v) => setMode(v as AiMode)}
            disabled={!canConfigure}
          >
            <SelectTrigger id="ai-mode" data-testid="ai-mode-select" className="max-w-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="DISABLED">{MODE_LABELS.DISABLED}</SelectItem>
              <SelectItem value="SUGGEST_ONLY">{MODE_LABELS.SUGGEST_ONLY}</SelectItem>
              <SelectItem value="AUTO_REPLY" disabled={!canEnableAuto}>
                {MODE_LABELS.AUTO_REPLY}
                {!canEnableAuto ? ' — réservé (OWNER/ADMIN)' : ''}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>

        {showAutoReplySettings ? (
          <div className="space-y-5 rounded-card border border-[#7C3AED]/20 bg-[#7C3AED]/5 p-4 dark:bg-[#7C3AED]/10">
            <div className="flex items-center justify-between gap-4">
              <div>
                <Label htmlFor="ai-auto-enabled">Auto-réponse activée</Label>
                <p className="text-xs text-muted-foreground">
                  L’IA envoie directement quand tous les garde-fous sont verts ; sinon elle propose
                  ou transfère à un humain.
                </p>
              </div>
              <Switch
                id="ai-auto-enabled"
                data-testid="ai-auto-enabled"
                checked={autoReplyEnabled}
                onCheckedChange={setAutoReplyEnabled}
                disabled={!canEnableAuto}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="ai-schedule">Couverture</Label>
              <Select
                value={scheduleMode}
                onValueChange={(v) => setScheduleMode(v as AiScheduleMode)}
                disabled={!canConfigure}
              >
                <SelectTrigger id="ai-schedule" data-testid="ai-schedule-select" className="max-w-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALWAYS">{SCHEDULE_LABELS.ALWAYS}</SelectItem>
                  <SelectItem value="OUTSIDE_BUSINESS_HOURS">
                    {SCHEDULE_LABELS.OUTSIDE_BUSINESS_HOURS}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="ai-max">Plafond de réponses auto / conversation / jour</Label>
              <Input
                id="ai-max"
                type="number"
                min={1}
                max={100}
                value={maxPerDay}
                onChange={(e) => setMaxPerDay(e.target.value)}
                disabled={!canConfigure}
                className="max-w-28"
                data-testid="ai-max-input"
              />
            </div>

            <div className="space-y-1.5">
              <Label>Sujets auto-envoyables</Label>
              <p className="text-xs text-muted-foreground">
                Une réponse ne part seule que si elle ne s’appuie que sur ces sujets.
              </p>
              <div className="flex flex-wrap gap-2 pt-1">
                {AI_AUTO_REPLY_CATEGORIES.map((cat) => {
                  const selected = categories.includes(cat);
                  return (
                    <button
                      key={cat}
                      type="button"
                      disabled={!canConfigure}
                      onClick={() => toggleCategory(cat)}
                      data-testid={`ai-category-${cat}`}
                      data-selected={selected}
                      className={cn(
                        'rounded-full border px-3 py-1 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60',
                        selected
                          ? 'border-[#7C3AED] bg-[#7C3AED]/10 text-[#7C3AED]'
                          : 'border-border text-muted-foreground hover:bg-muted',
                      )}
                    >
                      {CATEGORY_LABELS[cat] ?? cat}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        ) : null}

        {canConfigure ? (
          <div className="flex justify-end">
            <Button type="button" onClick={save} disabled={update.isPending} data-testid="ai-config-save">
              {update.isPending ? <Loader2 aria-hidden className="h-4 w-4 animate-spin" /> : null}
              Enregistrer
            </Button>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            Vous n’avez pas la permission de modifier la configuration IA.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
