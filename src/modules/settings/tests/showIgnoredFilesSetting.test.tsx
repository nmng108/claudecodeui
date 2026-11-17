import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import '@/modules/i18n';
import AppearanceSettingsTab from '@/modules/settings/tabs/AppearanceSettingsTab';
import { ThemeProvider } from '@/shared/context/ThemeContext';
import { UiPreferencesProvider, useUiPreferences } from '@/shared/context/UiPreferencesContext';
import { resetUserPreferences } from '@/shared/userSettings';

/**
 * The file tree hides what .gitignore excludes until the user turns this
 * switch on in Settings > Appearance; the tree reads the same preference.
 */

const codeEditorSettings = { theme: 'dark', wordWrap: false, showMinimap: true, lineNumbers: true, fontSize: '12' };

/** Mirrors what the file tree reads, so the test sees the switch's effect and not just its look. */
function PreferenceProbe() {
  const { showIgnoredFiles } = useUiPreferences();
  return <output data-testid="probe">{String(showIgnoredFiles)}</output>;
}

const renderTab = () => render(
  <ThemeProvider>
    <UiPreferencesProvider>
    <AppearanceSettingsTab
      projectSortOrder="name"
      onProjectSortOrderChange={vi.fn()}
      codeEditorSettings={codeEditorSettings as never}
      onCodeEditorWordWrapChange={vi.fn()}
      onCodeEditorShowMinimapChange={vi.fn()}
      onCodeEditorLineNumbersChange={vi.fn()}
      onCodeEditorFontSizeChange={vi.fn()}
    />
    <PreferenceProbe />
    </UiPreferencesProvider>
  </ThemeProvider>,
);

describe('Show ignored files setting', () => {
  beforeEach(() => {
    localStorage.clear();
    resetUserPreferences();
  });

  it('is off at first, so ignored files stay hidden', () => {
    renderTab();

    expect(screen.getByRole('switch', { name: 'Show ignored files' }).getAttribute('aria-checked')).toBe('false');
    expect(screen.getByTestId('probe').textContent).toBe('false');
  });

  it('turns on and off with the switch', () => {
    renderTab();
    const toggle = screen.getByRole('switch', { name: 'Show ignored files' });

    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(screen.getByTestId('probe').textContent).toBe('true');

    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(screen.getByTestId('probe').textContent).toBe('false');
  });
});
