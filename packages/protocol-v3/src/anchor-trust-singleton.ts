import { createAnchorTrustApi } from "./index.js";
import {
	certifiedSealAuthorityResolver,
	installCertifiedSealAuthorityResolver,
} from "./internal/seal-authority-custody.js";

const anchorTrustApi = createAnchorTrustApi();
installCertifiedSealAuthorityResolver(anchorTrustApi[certifiedSealAuthorityResolver]);

export const {
	authenticateCurrentEpochAnchor,
	installCertifiedAnchorTrustRoot,
	installCreatorAnchorTrustRoot,
	isAnchorTrustStateRecordBytes,
	openCertifiedAnchorTrust,
	openCurrentAnchorTrust,
	openCurrentEpochAuthorAuthorization,
	resolveCurrentEpochAuthorizedAuthor,
} = anchorTrustApi;
