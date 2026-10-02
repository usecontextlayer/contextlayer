// Dial outcome, back on the customer's leg. A completed status ends quietly;
// every other reported status (busy, no-answer, failed) gets the honest
// not-available message pointing at the WhatsApp row. Either way slate's
// machine shows the miss itself — a disconnect without an accept.
exports.handler = (_context, event, callback) => {
	const response = new Twilio.twiml.VoiceResponse()
	if (event.DialCallStatus !== "completed") {
		response.say(
			"The founder isn't available right now. Try the WhatsApp button instead.",
		)
	}
	callback(null, response)
}
