/**
 * Shows the most recent unhandled error, if there is one.
 *
 * The point of this component is that a Release build has nowhere else to put an error. Rendered
 * above the tab bar so it is visible from any screen - a throw in a deep screen should not require
 * navigating to a particular one to find out.
 */

import { useEffect, useState } from 'react';
import { Banner } from './components';
import { clearLatestError, onCapturedError } from './native/errorReporting';

export function CrashNotice() {
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => onCapturedError((error) => setMessage(error.message)), []);

  if (message === null) {
    return null;
  }

  return (
    <Banner
      tone="danger"
      title="Something went wrong"
      message={message}
      onDismiss={() => {
        clearLatestError();
        setMessage(null);
      }}
    />
  );
}
