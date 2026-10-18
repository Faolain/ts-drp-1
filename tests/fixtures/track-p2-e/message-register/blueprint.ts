type MessageState = { readonly message: string; readonly sequence: number };
type MessageInput = {
	readonly operation: { readonly arguments: { readonly message: string; readonly sequence: number } };
	readonly state: MessageState;
};

function clearMessageReducer(input: MessageInput): { readonly output: string; readonly state: MessageState } {
	const state = { message: "", sequence: input.state.sequence };
	return { output: state.message, state };
}

function setMessageReducer(input: MessageInput): { readonly output: string; readonly state: MessageState } {
	const state = {
		message: input.operation.arguments.message,
		sequence: input.operation.arguments.sequence,
	};
	return { output: state.message, state };
}
