'use client';

import * as React from 'react';

import { Input } from '@/components/ui/input';

/** Liste IANA du navigateur (validée strictement côté backend de toute façon). */
function supportedTimezones(): string[] {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return ['Africa/Douala', 'Africa/Lagos', 'Africa/Abidjan', 'Europe/Paris', 'UTC'];
  }
}

const TimezoneInput = React.forwardRef<HTMLInputElement, React.ComponentProps<'input'>>(
  (props, ref) => {
    const [timezones] = React.useState(supportedTimezones);
    return (
      <>
        <Input ref={ref} list="whauto-timezones" {...props} />
        <datalist id="whauto-timezones">
          {timezones.map((timezone) => (
            <option key={timezone} value={timezone} />
          ))}
        </datalist>
      </>
    );
  },
);
TimezoneInput.displayName = 'TimezoneInput';

export { TimezoneInput };
