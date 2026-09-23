import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// Motion calls window.scrollTo when animating to height 'auto'; jsdom doesn't implement it.
window.scrollTo = () => {};

afterEach(() => {
  cleanup();
});
