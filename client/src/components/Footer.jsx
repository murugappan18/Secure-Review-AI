import { Globe, Mail } from 'lucide-react';

// Brand icons inlined as SVG. Recent lucide-react versions trimmed several
// brand-specific icons (Github, Linkedin, Twitter, ...) in favor of a
// "generic UI icons only" policy. We don't want the build to break the
// next time they prune something else, so brand icons live here.

function Github({ className }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      className={className}
    >
      <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.56 0-.28-.01-1.02-.02-2-3.2.69-3.87-1.54-3.87-1.54-.52-1.33-1.28-1.68-1.28-1.68-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.7 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.47.11-3.07 0 0 .97-.31 3.18 1.18a11 11 0 0 1 5.79 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.6.23 2.78.12 3.07.74.81 1.18 1.84 1.18 3.1 0 4.43-2.69 5.4-5.26 5.69.41.36.78 1.06.78 2.14 0 1.55-.01 2.8-.01 3.18 0 .31.21.68.8.56C20.21 21.39 23.5 17.08 23.5 12 23.5 5.65 18.35.5 12 .5z" />
    </svg>
  );
}

function Linkedin({ className }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      className={className}
    >
      <path d="M19 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zM8.339 18.337H5.667v-8.59h2.672v8.59zM7.003 8.574a1.548 1.548 0 1 1 0-3.096 1.548 1.548 0 0 1 0 3.096zm11.335 9.763h-2.669V14.16c0-.996-.018-2.277-1.388-2.277-1.39 0-1.601 1.086-1.601 2.207v4.248h-2.667v-8.591h2.56v1.174h.037c.355-.675 1.227-1.387 2.524-1.387 2.704 0 3.203 1.778 3.203 4.092v4.711z" />
    </svg>
  );
}

const LINKS = {
  github: 'https://github.com/murugappan18',
  portfolio: 'https://murugappan18.github.io/my-portfolio',
  linkedin: 'https://www.linkedin.com/in/murugappan-p',
  email: 'mailto:murugappanp24@gmail.com'
};

export default function Footer() {
  const year = new Date().getFullYear();
  return (
    <footer className="border-t border-slate-800 bg-slate-950/80 backdrop-blur-sm mt-auto">
      <div className="max-w-5xl mx-auto px-6 py-5 flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-slate-400">
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
          <span>© {year} SecureReview AI</span>
          <span aria-hidden="true" className="text-slate-700">·</span>
          <span>Developed by</span>
          <a
            href={LINKS.portfolio}
            target="_blank"
            rel="noreferrer"
            className="text-slate-200 font-medium hover:text-white transition-colors"
          >
            Murugappan P
          </a>
          <span aria-hidden="true" className="text-slate-700 hidden sm:inline">·</span>
          <a
            href={`${LINKS.email}`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-slate-400 hover:text-slate-200 transition-colors"
          >
            <Mail className="w-3 h-3" />
            Contact me
          </a>
        </div>

        <div className="flex items-center gap-1">
          <FooterIconLink
            href={LINKS.portfolio}
            label="Portfolio"
            icon={<Globe className="w-4 h-4" />}
          />
          <FooterIconLink
            href={LINKS.github}
            label="GitHub"
            icon={<Github className="w-4 h-4" />}
          />
          <FooterIconLink
            href={LINKS.linkedin}
            label="LinkedIn"
            icon={<Linkedin className="w-4 h-4" />}
          />
        </div>
      </div>
    </footer>
  );
}

function FooterIconLink({ href, label, icon }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      aria-label={label}
      title={label}
      className="p-2 rounded-md text-slate-400 hover:text-slate-100 hover:bg-slate-800/60 transition-colors"
    >
      {icon}
    </a>
  );
}
