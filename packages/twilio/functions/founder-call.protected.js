// Voice webhook for the "Slate founder call" TwiML App: a browser client
// (slate's Voice SDK Device) connects, and this dials the founder's cell with
// the keypress answer gate riding on the callee leg (founder-call-whisper).
// answerOnBridge defers the bridge until the gate accepts — a voicemail
// pickup never counts as an answer. No early media reaches the browser leg:
// the customer's ring phase is silent (slate's animated ellipsis is the
// feedback there).
exports.handler = (context, _event, callback) => {
	const response = new Twilio.twiml.VoiceResponse()
	const dial = response.dial({
		action: "/founder-call-status",
		answerOnBridge: true,
		// The account's own number (also the unadvertised dial-in line) — a
		// caller ID is REQUIRED here because the customer leg is a browser
		// client (from = client:founder_call, invalid for PSTN). A public,
		// sid-stable infrastructure constant, so hardcoded, not env.
		callerId: "+18317773778",
		timeout: 25,
	})
	dial.number({ url: "/founder-call-whisper" }, context.CTX_FOUNDER_CELL)
	callback(null, response)
}
