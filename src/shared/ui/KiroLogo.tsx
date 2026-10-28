type KiroLogoProps = {
  className?: string;
};

/** Rendered by the shared LLMProviderLogo when the provider is Kiro. */
const KiroLogo = ({ className = 'w-5 h-5' }: KiroLogoProps) => (
  <svg
    viewBox="0 0 24 24"
    role="img"
    aria-label="Kiro"
    className={className}
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <rect x="2.5" y="2.5" width="19" height="19" rx="6" className="fill-foreground" />
    <path
      d="M12 6.5l2.1 4.26 4.7.68-3.4 3.32.8 4.68L12 17.27l-4.2 2.17.8-4.68-3.4-3.32 4.7-.68L12 6.5z"
      className="fill-background"
    />
  </svg>
);

export default KiroLogo;
