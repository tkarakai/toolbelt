// Plugins name lucide icons in kebab-case ("square-terminal"); look them up by name.
import { icons, type LucideProps } from "lucide-react";

const pascal = (name: string) => name.replace(/(^|-)([a-z0-9])/g, (_, __, c: string) => c.toUpperCase());

export function Icon({ name, ...props }: { name?: string } & LucideProps) {
	const C = (name && icons[pascal(name) as keyof typeof icons]) || icons.Box;
	return <C {...props} />;
}
