import { Github, Linkedin, Globe, Mail } from 'lucide-react';

const LINKS = {
  github: 'https://github.com/murugappan1',
  portfolio: 'https://murugappan18.github.io/my-portfolio',
  linkedin: 'https://www.linkedin.com/in/murugappan-p',
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
            href={`${LINKS.linkedin}/`}
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
