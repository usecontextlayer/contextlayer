export function redactSecrets(text: string, secrets: readonly string[]) {
	for (const secret of secrets.filter(Boolean))
		text = text.split(secret).join("[REDACTED]")
	return text
}
