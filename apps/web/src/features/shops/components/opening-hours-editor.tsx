'use client';

import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { getErrorMessage } from '@/lib/api/api-error';

import type { DayOfWeek, OpeningHourDay } from '../api';
import { DAY_LABELS, normalizeWeek, validateOpeningDays } from '../opening-hours';

interface OpeningHoursEditorProps {
  initialDays: OpeningHourDay[];
  onSave: (days: OpeningHourDay[]) => Promise<void>;
  readOnly?: boolean;
}

export function OpeningHoursEditor({ initialDays, onSave, readOnly = false }: OpeningHoursEditorProps) {
  const [days, setDays] = useState<OpeningHourDay[]>(() => normalizeWeek(initialDays));
  const [errors, setErrors] = useState<Partial<Record<DayOfWeek, string>>>({});
  const [saving, setSaving] = useState(false);

  function updateDay(dayOfWeek: DayOfWeek, updater: (day: OpeningHourDay) => OpeningHourDay) {
    setDays((current) => current.map((day) => (day.dayOfWeek === dayOfWeek ? updater(day) : day)));
  }

  function toggleDay(dayOfWeek: DayOfWeek, open: boolean) {
    updateDay(dayOfWeek, (day) => ({
      ...day,
      isClosed: !open,
      periods: open
        ? day.periods.length > 0
          ? day.periods
          : [{ opensAt: '08:00', closesAt: '18:00' }]
        : [],
    }));
  }

  async function save() {
    const validationErrors = validateOpeningDays(days);
    setErrors(validationErrors);
    if (Object.keys(validationErrors).length > 0) {
      return;
    }
    setSaving(true);
    try {
      await onSave(days);
      toast.success('Horaires enregistrés');
    } catch (error) {
      toast.error(getErrorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-3">
      {days.map((day) => (
        <div key={day.dayOfWeek} className="rounded-md border border-border p-3">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <Switch
                checked={!day.isClosed}
                onCheckedChange={(checked) => toggleDay(day.dayOfWeek, checked)}
                disabled={readOnly}
                aria-label={`${DAY_LABELS[day.dayOfWeek]} ouvert`}
              />
              <span className="w-24 text-sm font-medium">{DAY_LABELS[day.dayOfWeek]}</span>
              {day.isClosed ? <span className="text-sm text-muted-foreground">Fermé</span> : null}
            </div>
            {!day.isClosed && !readOnly ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() =>
                  updateDay(day.dayOfWeek, (current) => ({
                    ...current,
                    periods: [...current.periods, { opensAt: '14:00', closesAt: '18:00' }],
                  }))
                }
              >
                <Plus aria-hidden />
                Ajouter une plage
              </Button>
            ) : null}
          </div>

          {!day.isClosed ? (
            <div className="mt-3 space-y-2">
              {day.periods.map((period, index) => (
                <div key={index} className="flex items-center gap-2">
                  <label className="sr-only" htmlFor={`${day.dayOfWeek}-opens-${index}`}>
                    Ouverture {DAY_LABELS[day.dayOfWeek]} plage {index + 1}
                  </label>
                  <Input
                    id={`${day.dayOfWeek}-opens-${index}`}
                    type="time"
                    className="w-32"
                    value={period.opensAt}
                    disabled={readOnly}
                    onChange={(event) =>
                      updateDay(day.dayOfWeek, (current) => ({
                        ...current,
                        periods: current.periods.map((p, i) =>
                          i === index ? { ...p, opensAt: event.target.value } : p,
                        ),
                      }))
                    }
                  />
                  <span className="text-sm text-muted-foreground">→</span>
                  <label className="sr-only" htmlFor={`${day.dayOfWeek}-closes-${index}`}>
                    Fermeture {DAY_LABELS[day.dayOfWeek]} plage {index + 1}
                  </label>
                  <Input
                    id={`${day.dayOfWeek}-closes-${index}`}
                    type="time"
                    className="w-32"
                    value={period.closesAt}
                    disabled={readOnly}
                    onChange={(event) =>
                      updateDay(day.dayOfWeek, (current) => ({
                        ...current,
                        periods: current.periods.map((p, i) =>
                          i === index ? { ...p, closesAt: event.target.value } : p,
                        ),
                      }))
                    }
                  />
                  {!readOnly && day.periods.length > 1 ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={`Supprimer la plage ${index + 1} de ${DAY_LABELS[day.dayOfWeek]}`}
                      onClick={() =>
                        updateDay(day.dayOfWeek, (current) => ({
                          ...current,
                          periods: current.periods.filter((_, i) => i !== index),
                        }))
                      }
                    >
                      <Trash2 aria-hidden className="text-destructive" />
                    </Button>
                  ) : null}
                </div>
              ))}
              {errors[day.dayOfWeek] ? (
                <Alert variant="destructive">
                  <AlertDescription>{errors[day.dayOfWeek]}</AlertDescription>
                </Alert>
              ) : null}
            </div>
          ) : null}
        </div>
      ))}

      {!readOnly ? (
        <Button onClick={() => void save()} loading={saving}>
          Enregistrer les horaires
        </Button>
      ) : null}
    </div>
  );
}
