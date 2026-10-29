package javax.security.sasl;

/**
 * The JDK's SASL client interface, which Android leaves out. The MongoDB driver's SCRAM-SHA-1/256 sign-in
 * implements it with its own client, so only the interface is needed here (same signatures as java.security.sasl).
 */
public interface SaslClient {
  String getMechanismName();

  boolean hasInitialResponse();

  byte[] evaluateChallenge(byte[] challenge) throws SaslException;

  boolean isComplete();

  byte[] unwrap(byte[] incoming, int offset, int len) throws SaslException;

  byte[] wrap(byte[] outgoing, int offset, int len) throws SaslException;

  Object getNegotiatedProperty(String propName);

  void dispose() throws SaslException;
}
