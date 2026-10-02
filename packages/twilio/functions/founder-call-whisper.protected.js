// Played to whatever answers the founder's cell, before any bridge: a human
// presses a key and the customer is connected (founder-call-accept); voicemail
// can't press, the Gather times out, and the fallthrough Hangup ends the callee
// leg unbridged — so the customer never lands in personal voicemail.
exports.handler = (_context, _event, callback) => {
	const response = new Twilio.twiml.VoiceResponse()
	const gather = response.gather({
		action: "/founder-call-accept",
		numDigits: 1,
		timeout: 8,
	})
	gather.say("Customer call from Slate. Press 1 to accept.")
	response.hangup()
	callback(null, response)
}
