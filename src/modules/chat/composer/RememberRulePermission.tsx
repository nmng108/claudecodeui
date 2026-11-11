import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ShieldAlertIcon } from 'lucide-react';

import type { PendingPermissionRequest, PermissionDecision, PermissionRememberChoice } from '@/shared/types';
import {
  Confirmation,
  ConfirmationAction,
  ConfirmationActions,
  ConfirmationRequest,
  ConfirmationTitle,
} from '@/modules/chat/composer/Confirmation';

type RememberRulePermissionProps = {
  request: PendingPermissionRequest;
  onDecision: (requestIds: string | string[], decision: PermissionDecision) => void;
};

const SCOPE_DEFAULTS: Record<string, string> = {
  session: 'This session',
  workspace: 'This workspace',
  user: 'All workspaces',
};

/**
 * Used by chat's PermissionRequestsBanner for a request from a provider that
 * labels its requests with a capability (Kiro): Allow once and Deny stay one
 * click, and "Always allow" opens a list of patterns (exact, wider, whole tool)
 * and where to keep the rule, when the provider offers any.
 */
export default function RememberRulePermission({ request, onDecision }: RememberRulePermissionProps) {
  const { t } = useTranslation('chat');
  const choices = request.rememberChoices ?? [];
  const scopes = request.rememberScopes ?? [];

  // Whether the rule picker is open; closed by default so the common Allow and Deny stay one click.
  const [isPickingRule, setIsPickingRule] = useState(false);
  // The offered pattern the user picked; starts on the narrowest so nothing broad is saved by accident.
  const [choiceId, setChoiceId] = useState(choices[0]?.id ?? '');
  // Where the rule is kept; starts on the narrowest scope (the session) for the same reason.
  const [scope, setScope] = useState(scopes[0] ?? 'session');

  const choiceLabel = (choice: PermissionRememberChoice) => {
    switch (choice.kind) {
      case 'exact':
        return t('permissions.remember.exact', { defaultValue: 'Only this one' });
      case 'subcommand':
        return t('permissions.remember.subcommand', { defaultValue: 'This subcommand with any arguments' });
      case 'command':
        return t('permissions.remember.command', { defaultValue: 'This command with any arguments' });
      case 'directory':
        return t('permissions.remember.directory', { defaultValue: 'Anything in this folder' });
      default:
        return t('permissions.remember.tool', {
          capability: request.capability ?? request.toolName,
          defaultValue: 'Entire tool ({{capability}})',
        });
    }
  };

  return (
    <Confirmation approval="pending">
      <ConfirmationTitle className="flex items-start gap-3">
        <ShieldAlertIcon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <ConfirmationRequest>
          <div>
            <span className="font-medium text-foreground">
              {t('permissions.remember.required', { defaultValue: 'Permission required' })}
            </span>
            {request.capability && (
              <span className="ml-2 text-muted-foreground">
                <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{request.capability}</code>
              </span>
            )}
          </div>
          {/* The sub-command or path asked about now; the title can be a whole pipeline. */}
          <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded-md border bg-muted/50 p-2 text-xs text-foreground">
            {request.askedResource ?? request.toolName}
          </pre>
        </ConfirmationRequest>
      </ConfirmationTitle>

      {isPickingRule && (
        <div className="mt-2 space-y-3 text-sm">
          <fieldset className="space-y-1">
            <legend className="mb-1 text-xs font-medium text-muted-foreground">
              {t('permissions.remember.ruleHeading', { defaultValue: 'Always allow' })}
            </legend>
            {choices.map((choice) => (
              <label key={choice.id} className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-0.5 hover:bg-muted/50">
                <input
                  type="radio"
                  name={`remember-choice-${request.requestId}`}
                  checked={choice.id === choiceId}
                  onChange={() => setChoiceId(choice.id)}
                />
                <span>{choiceLabel(choice)}</span>
                <code className="ml-auto rounded bg-muted px-1.5 py-0.5 text-xs">{choice.pattern}</code>
              </label>
            ))}
          </fieldset>

          <fieldset className="space-y-1">
            <legend className="mb-1 text-xs font-medium text-muted-foreground">
              {t('permissions.remember.scopeHeading', { defaultValue: 'Keep this rule for' })}
            </legend>
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              {scopes.map((option) => (
                <label key={option} className="flex cursor-pointer items-center gap-1.5">
                  <input
                    type="radio"
                    name={`remember-scope-${request.requestId}`}
                    checked={option === scope}
                    onChange={() => setScope(option)}
                  />
                  <span>{t(`permissions.remember.scope.${option}`, { defaultValue: SCOPE_DEFAULTS[option] ?? option })}</span>
                </label>
              ))}
            </div>
          </fieldset>
        </div>
      )}

      <ConfirmationActions>
        <ConfirmationAction
          variant="outline"
          onClick={() => onDecision(request.requestId, { allow: false, message: t('misc.userDeniedTool') })}
        >
          {t('permissions.remember.deny', { defaultValue: 'Deny' })}
        </ConfirmationAction>
        {isPickingRule ? (
          <>
            <ConfirmationAction variant="ghost" onClick={() => setIsPickingRule(false)}>
              {t('permissions.remember.back', { defaultValue: 'Back' })}
            </ConfirmationAction>
            <ConfirmationAction
              variant="default"
              onClick={() => onDecision(request.requestId, { allow: true, rememberChoice: { choiceId, scope } })}
            >
              {t('permissions.remember.save', { defaultValue: 'Allow & remember' })}
            </ConfirmationAction>
          </>
        ) : (
          <>
            {/* No offered rule means the provider will not save one for this request. */}
            {choices.length > 0 && (
              <ConfirmationAction variant="outline" onClick={() => setIsPickingRule(true)}>
                {t('permissions.remember.always', { defaultValue: 'Always allow…' })}
              </ConfirmationAction>
            )}
            <ConfirmationAction variant="default" onClick={() => onDecision(request.requestId, { allow: true })}>
              {t('permissions.remember.once', { defaultValue: 'Allow once' })}
            </ConfirmationAction>
          </>
        )}
      </ConfirmationActions>
    </Confirmation>
  );
}
